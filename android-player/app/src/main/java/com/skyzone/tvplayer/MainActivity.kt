package com.skyzone.tvplayer

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

/**
 * Full-screen kiosk WebView that loads the Skyzone TV player page.
 * First boot asks for the server URL (e.g. http://192.168.1.50:8080/player/),
 * stores it, and auto-loads it on every launch. Press MENU (☰) on the remote
 * to change the URL later. Auto-retries if the server is unreachable.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("skyzone", MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)
        hideSystemUi()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // localStorage keeps the TV's identity
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        webView.setBackgroundColor(android.graphics.Color.BLACK)
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    // Server briefly down (e.g. being restarted): retry until it's back.
                    view.postDelayed({ view.loadUrl(playerUrl()) }, 5000)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Web renderer crashed after hours of playback: rebuild the
                // whole activity instead of showing a dead white screen.
                recreate()
                return true
            }
        }

        val url = prefs.getString("serverUrl", null)
        if (url == null) promptForUrl() else webView.loadUrl(playerUrl())
        ensureBootPermission()
    }

    /** Boot auto-start needs "Display over other apps"; ask until granted. */
    private fun ensureBootPermission() {
        if (Settings.canDrawOverlays(this)) return
        AlertDialog.Builder(this)
            .setTitle("Allow auto-start after power loss")
            .setMessage("Enable \"Display over other apps\" for Skyzone TV Player so the player relaunches by itself when the box reboots.")
            .setPositiveButton("Open setting") { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)) } catch (_: Exception) {}
                }
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun playerUrl(): String {
        var base = prefs.getString("serverUrl", "") ?: ""
        if (!base.startsWith("http")) base = "http://$base"
        base = base.trimEnd('/')
        if (!base.endsWith("/player")) base = "$base/player"
        return "$base/"
    }

    private fun promptForUrl() {
        val input = EditText(this).apply {
            hint = "http://192.168.1.50:8080"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString("serverUrl", ""))
        }
        AlertDialog.Builder(this)
            .setTitle("Skyzone TV server address")
            .setMessage("Enter the server address shown when the server starts (IP + port).")
            .setView(input)
            .setCancelable(prefs.contains("serverUrl"))
            .setPositiveButton("Connect") { _, _ ->
                prefs.edit().putString("serverUrl", input.text.toString().trim()).apply()
                webView.loadUrl(playerUrl())
            }
            .show()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            promptForUrl()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }
}
