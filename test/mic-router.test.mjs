import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')

const m = html.match(/ENGINE-START([\s\S]*?)ENGINE-END/)
assert.ok(m, 'ENGINE-START/END markers found in index.html')
let engineCode = m[1]
// تنظيف الحواف: نهاية التعليق الافتتاحية + تذييل علامة النهاية الحرفية
engineCode = engineCode.replace(/^[^\n]*\*\//, '').replace(/\/\* ===== $/, '')

/* ── محاكاة Web Audio ─────────────────────────── */
function makeMocks() {
  const log = { constraints: null, latencyHint: null, tracksStopped: 0, disconnected: [] }

  function makeNode(type) {
    return {
      type,
      connects: [],
      params: {},
      connect(target) {
        this.connects.push(target)
      },
      disconnect() {
        log.disconnected.push(type)
      },
      gain: { value: 0, setTargetAtTime(v) { this.value = v } },
      delayTime: { value: 0, setTargetAtTime(v) { this.value = v } },
      frequency: { value: 0, setTargetAtTime(v) { this.value = v } },
      Q: { value: 0.7 },
    }
  }

  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: makeNode('destination'),
    async resume() { this.state = 'running' },
    createBiquadFilter: () => makeNode('biquad'),
    createGain: () => makeNode('gain'),
    createDelay(max) { const n = makeNode('delay'); n.max = max; return n },
    createMediaStreamSource(stream) { const n = makeNode('source'); n.stream = stream; return n },
    createMediaStreamDestination() { const n = makeNode('recDest'); n.stream = { getTracks: () => [] }; return n },
  }

  global.window = {
    AudioContext: function (opts) { log.latencyHint = opts && opts.latencyHint; return ctx },
  }
  Object.defineProperty(global, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          log.constraints = constraints
          return { getTracks: () => [{ stop() { log.tracksStopped++ } }] }
        },
      },
    },
    configurable: true,
    writable: true,
  })
  return { ctx, log }
}

function loadRouter() {
  // تنفيذ كود المحرك في نطاق بمحاكاة
  const fn = new Function(engineCode)
  fn()
  return global.window.Router
}

/* ── محاكاة MediaRecorder ─────────────────────── */
function installRecorderMock(log) {
  class MockRecorder {
    static isTypeSupported(t) {
      return t.includes('webm') || t.includes('mp4')
    }
    constructor(stream, opts) {
      log.recorderStream = stream
      log.recorderOpts = opts
      this.mimeType = (opts && opts.mimeType) || 'audio/webm'
      this.state = 'inactive'
    }
    start(ts) {
      this.state = 'recording'
      log.recStartTimeslice = ts
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3, 4])]) })
      }
    }
    stop() {
      this.state = 'inactive'
      log.recStopped = true
      queueMicrotask(() => {
        if (this.onstop) this.onstop()
      })
    }
  }
  global.MediaRecorder = MockRecorder
}

/* ── الاختبارات ────────────────────────────────── */
test('المحرك: إعدادات الميكروفون تعطّل المعالجة المدمجة', async () => {
  const { log } = makeMocks()
  const Router = loadRouter()
  await Router.start()
  assert.equal(log.constraints.audio.echoCancellation, false)
  assert.equal(log.constraints.audio.noiseSuppression, false)
  assert.equal(log.constraints.audio.autoGainControl, false)
})

test('أندرويد: إعدادات الميكروفون تستخدم الافتراضيات (معالجة مدمجة — لا يكتم المخرج)', async () => {
  const { log } = makeMocks()
  global.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'
  const Router = loadRouter()
  await Router.start()
  assert.equal(log.constraints.audio.echoCancellation, true, 'AEC مفعل — مسار الوسائط لا وضع الاتصال')
  assert.equal(log.constraints.audio.noiseSuppression, true)
  assert.equal(log.constraints.audio.autoGainControl, true)
  delete global.navigator.userAgent
})

test('التشخيص: diagnose() يعرض حالة المحرك والمسار الجاف', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()
  const d = Router.diagnose()
  assert.equal(d.ctxState, 'running')
  assert.equal(d.gain, 1)
  assert.equal(d.monitor, 1)
  assert.equal(d.micActive, true)
  assert.equal(d.dryPathToSpeakers, true)
})

test('التسجيل: يبدأ MediaRecorder على وجهة التسجيل بصيغة مدعومة', async () => {
  const { log } = makeMocks()
  installRecorderMock(log)
  const Router = loadRouter()
  await Router.start()
  Router.startRecorder()
  assert.ok(Router.isRecording)
  assert.equal(log.recorderStream, Router.recDest.stream, 'يسجل من وجهة التسجيل وليس من الميكروفون مباشرة')
  assert.equal(log.recorderOpts.mimeType, 'audio/webm;codecs=opus', 'أفضل صيغة مدعومة')
  assert.equal(log.recStartTimeslice, 250)
  assert.equal(Router.chunks.length, 1, 'القطعة الأولى دخلت')
})

test('التسجيل: الإيقاف يحفظ Blob ويستدعي onRecordingComplete بالمدة', async () => {
  const { log } = makeMocks()
  installRecorderMock(log)
  const Router = loadRouter()
  let captured = null
  Router.onRecordingComplete = (d) => { captured = d }
  await Router.start()
  Router.startRecorder()
  Router.recStartTime = Date.now() - 5000 // مدة 5 ثوانٍ
  Router.stopRecorder()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(captured, 'اكتمل التسجيل')
  assert.ok(captured.blob instanceof Blob)
  assert.equal(captured.mime, 'audio/webm;codecs=opus')
  assert.equal(captured.duration, 5)
  assert.ok(captured.blob.size > 0)
})

test('التسجيل: Router.stop() يوقف التسجيل الجاري ويحفظه وينظف', async () => {
  const { log } = makeMocks()
  installRecorderMock(log)
  const Router = loadRouter()
  let captured = null
  Router.onRecordingComplete = (d) => { captured = d }
  await Router.start()
  Router.startRecorder()
  Router.stop()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(log.recStopped, 'المسجل أُوقف')
  assert.ok(captured, 'التسجيل حُفظ')
  assert.equal(log.tracksStopped, 1, 'مسار الميكروفون توقف')
  assert.equal(Router.isRecording, false)
})

test('التسجيل: بدون جلسة نشطة لا يبدأ المسجل', async () => {
  const { log } = makeMocks()
  installRecorderMock(log)
  const Router = loadRouter()
  Router.startRecorder()
  assert.equal(Router.isRecording, false)
  assert.equal(log.recorderStream, undefined)
})

test('التسجيل: إيقاف ثم بدء جديد ينتج تسجيلين مستقلين', async () => {
  const { log } = makeMocks()
  installRecorderMock(log)
  const Router = loadRouter()
  let count = 0
  Router.onRecordingComplete = () => count++
  await Router.start()
  Router.startRecorder()
  Router.stopRecorder()
  await new Promise((r) => setTimeout(r, 5))
  Router.startRecorder()
  Router.stopRecorder()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(count, 2, 'تسجيلان كاملان')
})

test('المحرك: AudioContext بزمن استجابة تفاعلي', async () => {
  const { log } = makeMocks()
  const Router = loadRouter()
  await Router.start()
  assert.equal(log.latencyHint, 'interactive')
})

test('المحرك: السلسلة الكاملة — مصدر ← تنقية ← حساسية ← مراقبة ← سماعات + تسجيل', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  // المصدر يتصل بالمرشح فقط (لا تجاوز للمكبرات مباشرة)
  assert.equal(Router.source.connects.length, 1)
  assert.equal(Router.source.connects[0], Router.hpf)
  // مرشح ← حساسية
  assert.equal(Router.hpf.connects.length, 1)
  assert.equal(Router.hpf.connects[0], Router.masterGain)
  // حساسية ← مراقبة المخرج + وجهة تسجيل + فرع الصدى (رطب)
  assert.equal(Router.masterGain.connects.length, 3)
  assert.ok(Router.masterGain.connects.includes(Router.monitorGain))
  assert.ok(Router.masterGain.connects.includes(Router.recDest))
  assert.ok(Router.masterGain.connects.includes(Router.wetGain))
  assert.ok(!Router.masterGain.connects.includes(ctx.destination), 'لا اتصال مباشر — يمر عبر المراقبة')
  // مراقبة المخرج ← السماعات (متصل دائماً)
  assert.equal(Router.monitorGain.connects.length, 1)
  assert.equal(Router.monitorGain.connects[0], ctx.destination)
  // نوع المرشح: highpass
  assert.equal(Router.hpf.type, 'highpass')
})

test('المحرك: فرع الصدى — حساسية ← رطب ← تأخير ← (تغذية راجعة ← تأخير) ← مراقبة + تسجيل', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  assert.equal(Router.wetGain.connects.length, 1)
  assert.equal(Router.wetGain.connects[0], Router.delay)
  assert.equal(Router.delay.connects.length, 3)
  assert.ok(Router.delay.connects.includes(Router.feedbackGain))
  assert.ok(Router.delay.connects.includes(Router.monitorGain))
  assert.ok(Router.delay.connects.includes(Router.recDest))
  assert.ok(!Router.delay.connects.includes(ctx.destination), 'الرطب يمر عبر المراقبة (يخضع للكتم)')
  assert.equal(Router.feedbackGain.connects.length, 1)
  assert.equal(Router.feedbackGain.connects[0], Router.delay)
})

test('المحرك: زمن الصدى 0% = بدون صدى (رطب مغلق) — وأي زمن > 0 يفتح الرطب', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setDelay(0)
  assert.equal(Router.current.delay, 0)
  assert.equal(Router.delay.delayTime.value, 0)
  assert.equal(Router.wetGain.gain.value, 0, 'الرطب مغلق عند زمن 0')

  Router.setDelay(50)
  assert.equal(Router.current.delay, 0.5)
  assert.equal(Router.delay.delayTime.value, 0.5)
  assert.equal(Router.wetGain.gain.value, 0.6, 'الرطب يُفتح عند وجود زمن صدى')

  Router.setDelay(0)
  assert.equal(Router.wetGain.gain.value, 0, 'الرطب يُغلق مجدداً عند الصفر')
})

test('المحرك: قوة الصدى = التغذية الراجعة 0..0.9', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setFeedback(0)
  assert.equal(Router.current.feedback, 0)
  assert.equal(Router.feedbackGain.gain.value, 0)

  Router.setFeedback(45)
  assert.equal(Router.current.feedback, 0.45)
  assert.equal(Router.feedbackGain.gain.value, 0.45)
})

test('المحرك: تنقية الضوضاء = 20..500 هرتز', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setHpf(0)
  assert.equal(Router.current.hpf, 20)
  assert.equal(Router.hpf.frequency.value, 20)

  Router.setHpf(50)
  assert.equal(Router.hpf.frequency.value, 20 + 240)

  Router.setHpf(100)
  assert.equal(Router.hpf.frequency.value, 500)
})

test('المحرك: الحساسية = كسب 0..2 (100% = 1)', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setGain(100)
  assert.equal(Router.current.gain, 1)
  assert.equal(Router.masterGain.gain.value, 1)

  Router.setGain(150)
  assert.equal(Router.masterGain.gain.value, 1.5)
})

test('المحرك: الإيقاف ينظف — يوقف المسارات ويفصل كل العقد', async () => {
  const { log } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.stop()
  assert.equal(log.tracksStopped, 1, 'مسار الميكروفون توقف')
  assert.ok(log.disconnected.includes('source'))
  assert.ok(log.disconnected.includes('biquad'))
  assert.ok(log.disconnected.includes('gain'))
  assert.ok(log.disconnected.includes('delay'))
  assert.ok(log.disconnected.includes('recDest'))
  assert.equal(Router.source, null)
  assert.equal(Router.masterGain, null)
  assert.equal(Router.monitorGain, null, 'مراقبة المخرج تنظف أيضاً')
})

test('المحرك: إعادة التشغيل بعد الإيقاف تعمل بمصدر جديد', async () => {
  const { log } = makeMocks()
  const Router = loadRouter()
  await Router.start()
  const s1 = Router.source
  Router.stop()
  await Router.start()
  const s2 = Router.source
  assert.notEqual(s1, s2, 'مصدر جديد بعد إعادة التشغيل')
  assert.equal(log.tracksStopped, 1)
})

test('المحرك: فشل إذن الميكروفون يرمي خطأ (واجهة الخطأ الودية تلتقطه)', async () => {
  makeMocks()
  global.navigator.mediaDevices.getUserMedia = async () => {
    throw new DOMException('Permission denied', 'NotAllowedError')
  }
  const Router = loadRouter()
  await assert.rejects(() => Router.start(), /Permission denied/)
})

test('المحرك: السياق المعلّق يُستأنف فوراً — قبل طلب الميكروفون', async () => {
  const { ctx } = makeMocks()
  ctx.state = 'suspended'
  const order = []
  ctx.resume = async () => {
    order.push('resume')
    ctx.state = 'running'
  }
  const orig = global.navigator.mediaDevices.getUserMedia
  global.navigator.mediaDevices.getUserMedia = async (c) => {
    order.push('mic')
    return orig(c)
  }
  const Router = loadRouter()
  await Router.start()
  assert.equal(order[0], 'resume', 'الاستئناف أولاً ضمن إيماءة المستخدم')
  assert.equal(order[1], 'mic', 'ثم طلب الميكروفون')
  assert.equal(Router.ctx.state, 'running')
  assert.equal(Router.masterGain.gain.value, 1, 'الحساسية 1.0 بعد التشغيل')
})

test('المحرك: فشل الاستئناف لا يمنع بناء المسار (يحاول مجدداً بعد البناء)', async () => {
  const { ctx } = makeMocks()
  ctx.state = 'suspended'
  let attempts = 0
  ctx.resume = async () => {
    attempts++
    throw new Error('not allowed')
  }
  const Router = loadRouter()
  await Router.start()
  assert.ok(Router.source, 'المسار بُني رغم رفض الاستئناف')
  assert.ok(attempts >= 2, `حاول الاستئناف مرتين (فعلياً ${attempts})`)
  assert.equal(Router.masterGain.gain.value, 1)
})

test('المحرك: المسار الجاف متصل دائماً بالسماعات حتى لو كل المؤثرات 0%', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  // الافتراضي: كل المؤثرات 0% والحساسية 100%
  assert.equal(Router.masterGain.gain.value, 1, 'الحساسية الافتراضية 1.0')
  assert.equal(Router.monitorGain.gain.value, 1, 'المراقبة مفتوحة افتراضياً')

  // السلسلة الجافة: حساسية ← مراقبة ← سماعات (متصل دائماً)
  assert.ok(Router.masterGain.connects.includes(Router.monitorGain))
  assert.equal(Router.monitorGain.connects.length, 1)
  assert.equal(Router.monitorGain.connects[0], ctx.destination)

  // حتى لو خفضنا كل المؤثرات للصفر، المسار للسماعات باقٍ
  Router.setDelay(0)
  Router.setFeedback(0)
  Router.setHpf(0)
  Router.setGain(100)
  assert.equal(Router.monitorGain.connects[0], ctx.destination, 'ما زال متصلاً')
  assert.equal(Router.masterGain.gain.value, 1)
})

test('المحرك: الحساسية محصّنة ضد NaN والنصوص — لا تنكسر أبداً', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setGain('abc')
  assert.equal(Router.current.gain, 1, 'نص → 1.0')
  assert.equal(Router.masterGain.gain.value, 1)
  Router.setGain(NaN)
  assert.equal(Router.current.gain, 1, 'NaN → 1.0')
  Router.setGain(undefined)
  assert.equal(Router.current.gain, 1, 'undefined → 1.0')
  Router.setGain(-50)
  assert.equal(Router.current.gain, 0, 'سالب → 0')
  Router.setGain(999)
  assert.equal(Router.current.gain, 2, 'فوق الحد → 2')

  Router.setDelay('xyz')
  assert.equal(Router.current.delay, 0, 'نص في زمن الصدى → 0')
  Router.setHpf(NaN)
  assert.equal(Router.current.hpf, 20, 'NaN في التنقية → 20Hz')
  Router.setFeedback('٪')
  assert.equal(Router.current.feedback, 0, 'رمز في قوة الصدى → 0')
})

test('المحرك: كتم المخرج — سماعات صامتة والتسجيل يستمر', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  Router.setMonitor(true)
  assert.equal(Router.monitorGain.gain.value, 0, 'المراقبة صفر (صامت)')
  assert.ok(Router.masterGain.connects.includes(Router.recDest), 'التسجيل متصل دائماً')
  assert.ok(Router.monitorGain.connects.includes(ctx.destination), 'المسار للسماعات باقٍ (صامت)')

  Router.setMonitor(false)
  assert.equal(Router.monitorGain.gain.value, 1, 'المراقبة عادت')

  // الكتم يُطبَّق حتى لو فُعّل قبل التشغيل
  Router.stop()
  Router.setMonitor(true)
  await Router.start()
  assert.equal(Router.monitorGain.gain.value, 0, 'الكتم سابق للتشغيل يُحترم')
})

test('المحرك: القيم المحفوظة تُطبَّق عند التشغيل (السلايدرات تبقى بعد إعادة التشغيل)', async () => {
  makeMocks()
  const Router = loadRouter()
  await Router.start()
  Router.setDelay(30)
  Router.setFeedback(20)
  Router.setHpf(60)
  Router.setGain(120)
  Router.stop()
  await Router.start()
  assert.equal(Router.delay.delayTime.value, 0.3)
  assert.equal(Router.feedbackGain.gain.value, 0.2)
  assert.equal(Router.hpf.frequency.value, 20 + 288)
  assert.equal(Router.masterGain.gain.value, 1.2)
})

test('iOS Safari: السياق يُعلَّق أثناء نافذة إذن الميكروفون — الاستئناف بعد الإذن يعيد التشغيل', async () => {
  const { ctx } = makeMocks()
  ctx.state = 'suspended'
  const order = []
  ctx.resume = async () => {
    order.push('resume')
    ctx.state = 'running'
  }
  const orig = global.navigator.mediaDevices.getUserMedia
  global.navigator.mediaDevices.getUserMedia = async (c) => {
    order.push('mic')
    ctx.state = 'suspended' // ⚠️ Safari يعلّق السياق أثناء النافذة
    return orig(c)
  }
  const Router = loadRouter()
  await Router.start()
  assert.equal(
    order.filter((x) => x === 'resume').length,
    2,
    'محاولتا استئناف: قبل الإذن وبعده',
  )
  assert.ok(
    order.lastIndexOf('resume') > order.indexOf('mic'),
    'الاستئناف الحاسم بعد الإذن',
  )
  assert.equal(ctx.state, 'running', 'السياق يعمل بعد الإذن')
  assert.ok(Router.source, 'العقد بُنيت بعد الاستئناف (لا تُبنى في سياق معلّق)')
  assert.equal(Router.masterGain.gain.value, 1, 'الحساسية 1.0')
})

test('iOS: resume لا يُنجز أبداً — الحد الزمني يمنع التعليق ويبني المسار', async () => {
  const { ctx } = makeMocks()
  ctx.state = 'suspended'
  ctx.resume = () => new Promise(() => {}) // خارج إيماءة iOS: لا يُنجز أبداً
  const Router = loadRouter()
  const t0 = Date.now()
  await Router.start()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, `start() لم يعلّق (استغرق ${elapsed}ms) — حد زمني 1200ms لكل محاولة`)
  assert.ok(Router.source, 'المسار بُني رغم رفض الاستئناف')
})
