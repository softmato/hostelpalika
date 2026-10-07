package com.softmato.hostelhub.bootsplash

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView

/*
 * Timeline and geometry. `src/components/brand-splash.tsx` plays the same
 * animation for phones without this module (iOS, the PWA) — keep the two in step.
 */
private const val STRIP_DELAY_MS = 300L
private const val STRIP_MS = 450L
private const val STRIP_RISE_DP = 14f
private const val SHINE_DELAY_MS = 750L
private const val SHINE_MS = 750L
private const val FADE_OUT_MS = 320L

/** The system draws `splashscreen_logo` in a 288dp icon box; drawing it in the same box lands every pixel in place. */
private const val LOGO_DP = 288f
private const val STRIP_WIDTH_DP = 136f
private const val STRIP_HEIGHT_DP = 55f
private const val STRIP_BOTTOM_DP = 60f

/** The band sweeps this far either side of the lockup's centre — past the ink (102dp wide at imageWidth 210) with room for the band. */
private const val SHINE_TRAVEL_DP = 83f
private const val SHINE_BAND_DP = 33f
private const val SHINE_ANGLE = 20f
private const val SHINE_ALPHA = 0.6f

/*
 * The loader under the wordmark. It fills with the shine — one animator drives
 * both — but only to LOADER_HOLD; the rest fills when JS says the app is up, so
 * a full bar always means ready, however slow the phone.
 */
private const val LOADER_WIDTH_DP = 80f
private const val LOADER_HEIGHT_DP = 3f
/** Bar centre below the screen centre: the wordmark's ink ends 43dp down (imageWidth 210), then a 22dp gap. */
private const val LOADER_OFFSET_DP = 67f
private const val LOADER_HOLD = 0.85f
private const val LOADER_FINISH_MS = 220L
/** `brand` and `brandSoft` in src/constants/theme.ts. */
private const val LOADER_FILL = 0xFF0A8A4B.toInt()
private const val LOADER_TRACK = 0xFFE6F4EC.toInt()

/** Never strand the user on the splash if JS fails to say it is up. */
private const val SAFETY_MS = 15_000L

/**
 * The launch screen, drawn by the app instead of the phone.
 *
 * What the system splash shows varies by phone: Android 11 and below have no
 * branding slot, some OEM skins drop it, and the rest force it into a 200x80dp
 * box. The one thing every phone draws the same is the background and the
 * centred logo — so the system splash (app.json) carries only that, and is let
 * go on the activity's first frame. This view is that frame: the same logo in
 * the same 288dp box, then "Powered by Softmato" rising in and a shine across
 * the logo with the loader under it filling in step, identical everywhere
 * because it is our code.
 *
 * It holds until JS calls `hide()` *and* the animation has played out, fills
 * the rest of the loader, then fades. Underneath, `BrandSplash` draws that end
 * state — full loader included — with the same pixels, so the fade never shows
 * a seam. MainActivity calls [show] — wired by
 * `plugins/withSplashBranding.js`.
 */
object BootSplash {
  private var shown = false
  private var overlay: View? = null
  private var loader: LoaderBarView? = null
  private var settled = false
  private var released = false
  private var leaving = false
  private val onGone = mutableListOf<() -> Unit>()

  /**
   * Once per process. A recreated activity (theme change, process kept alive)
   * finds JS already running, and covering it would only hide a ready screen.
   */
  @JvmStatic
  fun show(activity: Activity, background: Int, logo: Int, strip: Int) {
    if (shown) return
    shown = true

    val density = activity.resources.displayMetrics.density
    fun dp(value: Float) = (value * density).toInt()

    val ground = activity.getColor(background)
    val logoView = ShineLogoView(activity, activity.getDrawable(logo)!!, ground)
    val stripView = ImageView(activity).apply {
      setImageResource(strip)
      scaleType = ImageView.ScaleType.FIT_CENTER
      alpha = 0f
      translationY = STRIP_RISE_DP * density
    }

    val loaderView = LoaderBarView(activity).apply {
      alpha = 0f
      translationY = LOADER_OFFSET_DP * density
    }

    val root = FrameLayout(activity).apply {
      setBackgroundColor(ground)
      // The app boots underneath; a tap must not land on it.
      isClickable = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      addView(logoView, FrameLayout.LayoutParams(dp(LOGO_DP), dp(LOGO_DP), Gravity.CENTER))
      addView(loaderView, FrameLayout.LayoutParams(dp(LOADER_WIDTH_DP), dp(LOADER_HEIGHT_DP), Gravity.CENTER))
      addView(
        stripView,
        FrameLayout.LayoutParams(
          dp(STRIP_WIDTH_DP),
          dp(STRIP_HEIGHT_DP),
          Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
        ).apply { bottomMargin = dp(STRIP_BOTTOM_DP) },
      )
    }

    /*
     * On the decor view, not `android.R.id.content`. In a release build
     * expo-updates holds `loadApp` until its launch asset is ready, and the
     * `setContentView` that follows empties the content view — a splash added
     * there was wiped before it drew, leaving the bare window behind the
     * system splash. The decor spans the whole window, the same box the system
     * centres its icon in.
     */
    (activity.window.decorView as ViewGroup)
      .addView(root, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    overlay = root
    loader = loaderView
    darkSystemBarIcons(activity)

    root.post { play(stripView, logoView, loaderView) }
    Handler(Looper.getMainLooper()).postDelayed({ hide {} }, SAFETY_MS)
  }

  /** JS is up. [done] runs once the splash is gone — at once if it never showed. */
  fun hide(done: () -> Unit) {
    if (overlay == null) {
      done()
      return
    }
    onGone += done
    released = true
    leaveIfReady()
  }

  /**
   * The system splash has dark status-bar icons on its white ground; a phone in
   * dark mode would turn them white here, and the clock would vanish into the
   * splash. JS keeps them dark until the splash is gone (`app/_layout.tsx`).
   */
  @Suppress("DEPRECATION")
  private fun darkSystemBarIcons(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
        WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      activity.window.insetsController?.setSystemBarsAppearance(light, light)
    } else {
      val decor = activity.window.decorView
      var flags = decor.systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
      }
      decor.systemUiVisibility = flags
    }
  }

  private fun play(strip: View, logo: ShineLogoView, bar: LoaderBarView) {
    strip
      .animate()
      .alpha(1f)
      .translationY(0f)
      .setStartDelay(STRIP_DELAY_MS)
      .setDuration(STRIP_MS)
      .setInterpolator(DecelerateInterpolator(1.5f))
      .start()
    bar.animate().alpha(1f).setStartDelay(STRIP_DELAY_MS).setDuration(STRIP_MS).start()

    ValueAnimator.ofFloat(0f, 1f).apply {
      startDelay = SHINE_DELAY_MS
      duration = SHINE_MS
      interpolator = AccelerateDecelerateInterpolator()
      addUpdateListener {
        val t = it.animatedValue as Float
        logo.progress = t
        bar.progress = t * LOADER_HOLD
      }
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          logo.progress = null
          settled = true
          leaveIfReady()
        }
      })
      start()
    }
  }

  private fun leaveIfReady() {
    val view = overlay ?: return
    if (!settled || !released || leaving) return
    leaving = true

    // Its activity went away mid-splash: nothing on screen to fade.
    if (!view.isAttachedToWindow) {
      finish(view)
      return
    }
    val bar = loader ?: return fadeOut(view)
    ValueAnimator.ofFloat(bar.progress, 1f).apply {
      duration = LOADER_FINISH_MS
      interpolator = DecelerateInterpolator()
      addUpdateListener { bar.progress = it.animatedValue as Float }
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) = fadeOut(view)
      })
      start()
    }
  }

  private fun fadeOut(view: View) {
    view
      .animate()
      .alpha(0f)
      .setDuration(FADE_OUT_MS)
      .setInterpolator(AccelerateInterpolator())
      .withEndAction { finish(view) }
      .start()
  }

  private fun finish(view: View) {
    (view.parent as? ViewGroup)?.removeView(view)
    overlay = null
    loader = null
    onGone.forEach { it() }
    onGone.clear()
  }
}

/**
 * The logo with a light band swept across it. The band is the splash ground
 * colour, so over the empty canvas it is invisible and over the ink it reads as
 * a shine — no mask needed.
 */
private class ShineLogoView(context: Context, private val logo: Drawable, ground: Int) : View(context) {
  private val density = resources.displayMetrics.density
  private val half = SHINE_BAND_DP * density / 2
  private val shift = Matrix()
  private val band =
    LinearGradient(
      -half,
      0f,
      half,
      0f,
      intArrayOf(
        Color.argb(0, Color.red(ground), Color.green(ground), Color.blue(ground)),
        Color.argb((SHINE_ALPHA * 255).toInt(), Color.red(ground), Color.green(ground), Color.blue(ground)),
        Color.argb(0, Color.red(ground), Color.green(ground), Color.blue(ground)),
      ),
      null,
      Shader.TileMode.CLAMP,
    )
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = band }

  /** 0 → 1 across the lockup; null when no band is drawn. */
  var progress: Float? = null
    set(value) {
      field = value
      invalidate()
    }

  override fun onDraw(canvas: Canvas) {
    logo.setBounds(0, 0, width, height)
    logo.draw(canvas)

    val t = progress ?: return
    val travel = SHINE_TRAVEL_DP * density
    val x = width / 2f - travel + t * 2 * travel
    shift.setTranslate(x, 0f)
    band.setLocalMatrix(shift)

    canvas.save()
    canvas.rotate(SHINE_ANGLE, x, height / 2f)
    canvas.drawRect(x - half, -height.toFloat(), x + half, 2f * height, paint)
    canvas.restore()
  }
}

/** A pill track with the fill growing from its left end. */
private class LoaderBarView(context: Context) : View(context) {
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = LOADER_TRACK }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = LOADER_FILL }

  /** 0 → 1. */
  var progress = 0f
    set(value) {
      field = value
      invalidate()
    }

  override fun onDraw(canvas: Canvas) {
    val h = height.toFloat()
    val r = h / 2
    canvas.drawRoundRect(0f, 0f, width.toFloat(), h, r, r, track)
    if (progress <= 0f) return
    // Never narrower than its own round end.
    canvas.drawRoundRect(0f, 0f, maxOf(h, width * progress), h, r, r, fill)
  }
}
