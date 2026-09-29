package com.softmato.hostelhub.qrscanner

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Size
import androidx.annotation.OptIn
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.ZoomSuggestionOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * A camera that does one thing: read a QR held up to it, fast.
 *
 * expo-camera's `CameraView` is a general camera with a scanner bolted on, and
 * every default it picks is a photo default. Three of them are why an ID card
 * sat blurry in front of it:
 *
 * - **No zoom.** The aiming window fills most of the screen, so people hold the
 *   card close enough to fill it — a few centimetres, inside the lens's minimum
 *   focus distance, where no amount of autofocus can make it sharp. At
 *   [START_ZOOM] the same framing happens with the card at arm's comfort, where
 *   the lens can focus. ML Kit's zoom suggestions push further in for a card
 *   held far away.
 * - **Whole-frame passive focus.** Continuous autofocus weighs the entire frame
 *   and drifts slowly; with a card in the middle and a room behind it, it is as
 *   happy to focus on the room. [refocus] fires an active focus scan on the
 *   centre, where the brackets are, and repeats it so a card brought in later is
 *   never more than [REFOCUS_MS] from sharp.
 * - **Full-resolution analysis.** expo-camera hands ML Kit the highest-resolution
 *   frame the sensor offers, and a QR needs a fraction of that. [ANALYSIS_SIZE]
 *   keeps every frame cheap, so the detector sees more of them.
 *
 * `active` is the caller's focus state, not a mount flag: a screen pushed on top
 * leaves this view mounted, and a camera left bound underneath keeps the torch
 * on and the sensor busy.
 */
@SuppressLint("ViewConstructor")
class QrScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onCode by EventDispatcher()

  private val previewView = PreviewView(context).apply {
    // A TextureView, so the React overlays drawn above it composite normally.
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val analysisExecutor = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  private var provider: ProcessCameraProvider? = null
  private var owner: LifecycleOwner? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var camera: Camera? = null
  private var scanner: BarcodeScanner? = null

  private var active = false
  private var torch = false
  private var lastCode: String? = null
  private var lastCodeAt = 0L

  private val refocus = object : Runnable {
    override fun run() {
      val camera = camera ?: return
      val centre = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f, FOCUS_AREA)

      camera.cameraControl.startFocusAndMetering(
        // AE as well: metering on the card rather than the room is what keeps a
        // white card under a tube light from blowing out.
        FocusMeteringAction.Builder(centre, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
          .disableAutoCancel()
          .build(),
      )
      main.postDelayed(this, REFOCUS_MS)
    }
  }

  init {
    addView(previewView)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    previewView.measure(widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.layout(0, 0, right - left, bottom - top)
  }

  fun setActive(value: Boolean) {
    if (value == active) return
    active = value
    if (value) start() else stop()
  }

  fun setTorch(value: Boolean) {
    torch = value
    camera?.cameraControl?.enableTorch(value)
  }

  fun release() {
    active = false
    stop()
    analysisExecutor.shutdown()
  }

  private fun start() {
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val future = ProcessCameraProvider.getInstance(context)

    future.addListener({
      // Blurred again while the provider was still warming up.
      if (active && camera == null) bind(future.get(), owner)
    }, ContextCompat.getMainExecutor(context))
  }

  private fun bind(provider: ProcessCameraProvider, owner: LifecycleOwner) {
    val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
    val analysis = ImageAnalysis.Builder()
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setResolutionStrategy(
            ResolutionStrategy(ANALYSIS_SIZE, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
          )
          .build(),
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()

    val camera = try {
      // One camera user at a time, same as expo-camera: whatever a previous
      // screen left bound would make this bind throw.
      provider.unbindAll()
      provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    } catch (e: Exception) {
      Log.e(TAG, "Could not open the back camera", e)
      return
    }

    val maxZoom = camera.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f
    val scanner = BarcodeScanning.getClient(
      BarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .setZoomSuggestionOptions(
          ZoomSuggestionOptions.Builder { ratio ->
            // Never back out past the starting framing — that is the one that
            // keeps the card inside the lens's focus range.
            camera.cameraControl.setZoomRatio(min(max(ratio, START_ZOOM), maxZoom))
            true
          }
            .setMaxSupportedZoomRatio(maxZoom)
            .build(),
        )
        .build(),
    )
    analysis.setAnalyzer(analysisExecutor) { image -> analyze(image, scanner) }

    this.provider = provider
    this.owner = owner
    this.preview = preview
    this.analysis = analysis
    this.camera = camera
    this.scanner = scanner

    // Zoom, torch and focus only take once the camera is open, and CameraX drops
    // them every time it closes — so they go back on at every OPEN, which also
    // covers the app returning from the background.
    camera.cameraInfo.cameraState.observe(owner) { state ->
      if (state.type == CameraState.Type.OPEN && this.camera === camera) {
        camera.cameraControl.setZoomRatio(min(START_ZOOM, maxZoom))
        camera.cameraControl.enableTorch(torch)
        main.removeCallbacks(refocus)
        main.post(refocus)
      }
    }
  }

  private fun stop() {
    main.removeCallbacks(refocus)
    owner?.let { camera?.cameraInfo?.cameraState?.removeObservers(it) }
    analysis?.clearAnalyzer()
    provider?.unbind(*listOfNotNull(preview, analysis).toTypedArray())
    scanner?.close()

    camera = null
    scanner = null
    preview = null
    analysis = null
  }

  @OptIn(ExperimentalGetImage::class)
  private fun analyze(image: ImageProxy, scanner: BarcodeScanner) {
    val media = image.image

    if (media == null) {
      image.close()
      return
    }

    scanner.process(InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees))
      .addOnSuccessListener { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let(::emit) }
      .addOnCompleteListener { image.close() }
  }

  /**
   * Once per code per [REPEAT_MS], not once per frame: a card held still is the
   * same read thirty times a second, and every one of them is a bridge crossing.
   */
  private fun emit(code: String) {
    val now = SystemClock.elapsedRealtime()
    if (code == lastCode && now - lastCodeAt < REPEAT_MS) return

    lastCode = code
    lastCodeAt = now
    onCode(mapOf("data" to code))
  }

  private companion object {
    const val TAG = "HostelHubQrScanner"

    // Calibration knobs, tuned for a Redmi-class main camera and a card-sized QR.
    // ponytail: fixed starting zoom; derive it from LENS_INFO_MINIMUM_FOCUS_DISTANCE if a phone still blurs.
    /** Enough to keep a card that fills the brackets outside the minimum focus distance. */
    const val START_ZOOM = 2f
    /** Plenty for a QR, and cheap enough that ML Kit keeps up with the preview. */
    val ANALYSIS_SIZE = Size(1280, 720)
    /** How long a card brought in after the last focus scan can stay soft. */
    const val REFOCUS_MS = 2000L
    /** The centre patch focus and exposure are measured on, as a fraction of the frame. */
    const val FOCUS_AREA = 0.3f
    const val REPEAT_MS = 1500L
  }
}
