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

test('المحرك: السلسلة الكاملة — مصدر ← تنقية ← حساسية ← مكبرات + تسجيل', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  // المصدر يتصل بالمرشح فقط (لا تجاوز للمكبرات مباشرة)
  assert.equal(Router.source.connects.length, 1)
  assert.equal(Router.source.connects[0], Router.hpf)
  // مرشح ← حساسية
  assert.equal(Router.hpf.connects.length, 1)
  assert.equal(Router.hpf.connects[0], Router.masterGain)
  // حساسية ← مكبرات + وجهة تسجيل + فرع الصدى (رطب)
  assert.equal(Router.masterGain.connects.length, 3)
  assert.ok(Router.masterGain.connects.includes(ctx.destination))
  assert.ok(Router.masterGain.connects.includes(Router.recDest))
  assert.ok(Router.masterGain.connects.includes(Router.wetGain))
  // نوع المرشح: highpass
  assert.equal(Router.hpf.type, 'highpass')
})

test('المحرك: فرع الصدى — حساسية ← رطب ← تأخير ← (تغذية راجعة ← تأخير) ← مكبرات + تسجيل', async () => {
  const { ctx } = makeMocks()
  const Router = loadRouter()
  await Router.start()

  assert.equal(Router.wetGain.connects.length, 1)
  assert.equal(Router.wetGain.connects[0], Router.delay)
  assert.equal(Router.delay.connects.length, 3)
  assert.ok(Router.delay.connects.includes(Router.feedbackGain))
  assert.ok(Router.delay.connects.includes(ctx.destination))
  assert.ok(Router.delay.connects.includes(Router.recDest))
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

test('المحرك: السياق المعلّق لا يعلق التشغيل (سباق مع مهلة)', async () => {
  const { ctx, log } = makeMocks()
  ctx.state = 'suspended'
  ctx.resume = () => new Promise(() => {}) // يعلّق للأبد
  const Router = loadRouter()
  const t0 = Date.now()
  await Router.start() // يجب أن يكمل خلال ~800ms
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 3000, `اكتمل خلال ${elapsed}ms`)
  assert.ok(Router.source, 'السلسلة بُنيت رغم تعليق resume')
  assert.ok(log.constraints, 'طلب الميكروفون تم قبل محاولة الاستئناف')
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
