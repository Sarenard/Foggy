package com.example.foggy

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.IOException
import java.util.Locale
import android.location.Geocoder
import org.osmdroid.config.Configuration
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Overlay
import org.osmdroid.views.overlay.mylocation.GpsMyLocationProvider
import org.osmdroid.views.overlay.mylocation.MyLocationNewOverlay
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.cos
import kotlin.math.pow

class MainActivity : AppCompatActivity() {

    companion object {
        private const val LOCATION_PERMISSION_REQUEST_CODE = 1
        private const val BACKGROUND_LOCATION_PERMISSION_REQUEST_CODE = 2
        private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 3
        private const val POINTS_REFRESH_INTERVAL_MS = 10_000L
        private const val POINT_DIAMETER_METERS = 3.0
        private const val CLEAR_RADIUS_METERS = 10.0
        private const val CLEAR_EDGE_FEATHER_METERS = 6.0
        private const val SHOW_SAVED_POINTS = false
    }

    private lateinit var map: MapView
    private lateinit var fogModeButton: Button
    private lateinit var trackingButton: Button
    private lateinit var currentCityText: TextView
    private lateinit var locationHistoryDatabase: LocationHistoryDatabase
    private lateinit var savedPointsOverlay: SavedPointsOverlay
    private lateinit var fogOverlay: FogOverlay
    private var locationOverlay: MyLocationNewOverlay? = null
    private var useBlackFog = true
    private var hasCenteredOnSavedPoint = false
    private var hasCenteredOnGps = false
    private var lastResolvedCityName: String? = null
    private val databaseExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val pointsRefreshHandler = Handler(Looper.getMainLooper())
    private val pointsRefresher = object : Runnable {
        override fun run() {
            refreshSavedPoints()
            pointsRefreshHandler.postDelayed(this, POINTS_REFRESH_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Configuration.getInstance().load(
            applicationContext,
            getSharedPreferences("osmdroid", MODE_PRIVATE)
        )

        setContentView(R.layout.activity_main)

        map = findViewById(R.id.map)
        fogModeButton = findViewById(R.id.fogModeButton)
        trackingButton = findViewById(R.id.trackingButton)
        currentCityText = findViewById(R.id.currentCityText)
        locationHistoryDatabase = LocationHistoryDatabase(applicationContext)
        savedPointsOverlay = SavedPointsOverlay()
        fogOverlay = FogOverlay()

        map.setMultiTouchControls(true)
        map.controller.setZoom(16.0)
        map.controller.setCenter(GeoPoint(45.75, 4.85))
        map.overlays.add(savedPointsOverlay)
        map.overlays.add(fogOverlay)
        centerMapOnSavedPointAtStartup()

        trackingButton.setOnClickListener {
            if (LocationTrackingService.isTrackingActive(this)) {
                stopTracking()
            } else {
                startTrackingFlow()
            }
        }

        fogModeButton.setOnClickListener {
            useBlackFog = !useBlackFog
            updateFogModeButton()
            map.invalidate()
        }

        refreshSavedPoints()
        syncTrackingUi()
        updateFogModeButton()
    }

    private fun startTrackingFlow() {
        if (!hasFineLocationPermission()) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
                LOCATION_PERMISSION_REQUEST_CODE
            )
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocationPermission()) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
                BACKGROUND_LOCATION_PERMISSION_REQUEST_CODE
            )
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                NOTIFICATION_PERMISSION_REQUEST_CODE
            )
            return
        }

        startTracking()
    }

    private fun startTracking() {
        LocationTrackingService.updateTrackingState(this, true)
        val serviceIntent = Intent(this, LocationTrackingService::class.java)
        ContextCompat.startForegroundService(this, serviceIntent)
        hasCenteredOnGps = false
        enableLocationOverlay()
        updateTrackingButton()
    }

    private fun stopTracking() {
        LocationTrackingService.updateTrackingState(this, false)
        stopService(Intent(this, LocationTrackingService::class.java))
        disableLocationOverlay()
        updateTrackingButton()
    }

    private fun hasFineLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasBackgroundLocationPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
    }

    private fun enableLocationOverlay() {
        if (!hasFineLocationPermission()) return

        val overlay = locationOverlay ?: MyLocationNewOverlay(GpsMyLocationProvider(this), map).also {
            locationOverlay = it
            map.overlays.add(it)
        }

        overlay.enableMyLocation()
        centerMapOnGpsWhenAvailable(overlay)
        updateCurrentCityFromLocation(overlay.myLocation)
        keepFogOverlayOnTop()
        map.invalidate()
    }

    private fun disableLocationOverlay() {
        locationOverlay?.let { overlay ->
            overlay.disableMyLocation()
            map.overlays.remove(overlay)
        }
        locationOverlay = null
        keepFogOverlayOnTop()
        map.invalidate()
    }

    private fun refreshSavedPoints() {
        databaseExecutor.execute {
            val points = locationHistoryDatabase.getAllPoints()
            runOnUiThread {
                savedPointsOverlay.setPoints(points)
                updateCurrentCityFromLocation(locationOverlay?.myLocation)
                map.invalidate()
            }
        }
    }

    private fun centerMapOnSavedPointAtStartup() {
        databaseExecutor.execute {
            val lastPoint = locationHistoryDatabase.getLastPoint()
            runOnUiThread {
                if (lastPoint == null || hasCenteredOnSavedPoint || hasCenteredOnGps) return@runOnUiThread

                map.controller.animateTo(GeoPoint(lastPoint.latitude, lastPoint.longitude))
                hasCenteredOnSavedPoint = true
            }
        }
    }

    private fun centerMapOnGpsWhenAvailable(overlay: MyLocationNewOverlay) {
        if (hasCenteredOnGps) return

        overlay.myLocation?.let { myLocation ->
            centerMapOnGps(myLocation)
            return
        }

        overlay.runOnFirstFix {
            val myLocation = overlay.myLocation ?: return@runOnFirstFix
            runOnUiThread {
                centerMapOnGps(myLocation)
                updateCurrentCityFromLocation(myLocation)
            }
        }
    }

    private fun centerMapOnGps(myLocation: GeoPoint) {
        if (hasCenteredOnGps) return

        map.controller.animateTo(myLocation)
        hasCenteredOnGps = true
    }

    private fun updateCurrentCityFromLocation(location: GeoPoint?) {
        if (location == null || !Geocoder.isPresent()) return

        databaseExecutor.execute {
            val cityName = reverseGeocodeCityName(location.latitude, location.longitude) ?: return@execute
            if (cityName == lastResolvedCityName) return@execute

            runOnUiThread {
                lastResolvedCityName = cityName
                currentCityText.text = cityName
            }
        }
    }

    private fun reverseGeocodeCityName(latitude: Double, longitude: Double): String? {
        return try {
            val geocoder = Geocoder(this, Locale.getDefault())
            val address = geocoder.getFromLocation(latitude, longitude, 1)?.firstOrNull() ?: return null

            address.locality
                ?: address.subAdminArea
                ?: address.adminArea
        } catch (_: IOException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun syncTrackingUi() {
        val trackingActive = LocationTrackingService.isTrackingActive(this)
        if (trackingActive && hasFineLocationPermission()) {
            enableLocationOverlay()
        } else {
            disableLocationOverlay()
        }
        keepFogOverlayOnTop()
        updateTrackingButton()
    }

    private fun keepFogOverlayOnTop() {
        map.overlays.remove(fogOverlay)
        map.overlays.add(fogOverlay)
    }

    private fun updateTrackingButton() {
        trackingButton.text = if (LocationTrackingService.isTrackingActive(this)) {
            getString(R.string.stop_tracking)
        } else {
            getString(R.string.start_tracking)
        }
    }

    private fun updateFogModeButton() {
        fogModeButton.text = if (useBlackFog) {
            getString(R.string.show_default_fog)
        } else {
            getString(R.string.show_black_fog)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            syncTrackingUi()
            return
        }

        when (requestCode) {
            LOCATION_PERMISSION_REQUEST_CODE,
            BACKGROUND_LOCATION_PERMISSION_REQUEST_CODE,
            NOTIFICATION_PERMISSION_REQUEST_CODE -> startTrackingFlow()
        }
    }

    override fun onResume() {
        super.onResume()
        map.onResume()
        syncTrackingUi()
        refreshSavedPoints()
        pointsRefreshHandler.removeCallbacks(pointsRefresher)
        pointsRefreshHandler.postDelayed(pointsRefresher, POINTS_REFRESH_INTERVAL_MS)
    }

    override fun onPause() {
        pointsRefreshHandler.removeCallbacks(pointsRefresher)
        locationOverlay?.disableMyLocation()
        map.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        pointsRefreshHandler.removeCallbacks(pointsRefresher)
        disableLocationOverlay()
        locationHistoryDatabase.close()
        databaseExecutor.shutdown()
        super.onDestroy()
    }

    private class SavedPointsOverlay : Overlay() {
        private val pointPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.RED
            style = Paint.Style.FILL
        }
        private var points: List<LocationHistoryDatabase.StoredLocationPoint> = emptyList()

        fun setPoints(newPoints: List<LocationHistoryDatabase.StoredLocationPoint>) {
            points = newPoints
        }

        fun getPoints(): List<LocationHistoryDatabase.StoredLocationPoint> = points

        override fun draw(canvas: Canvas, mapView: MapView, shadow: Boolean) {
            if (shadow || !SHOW_SAVED_POINTS || points.isEmpty()) return

            val width = mapView.width.toFloat()
            val height = mapView.height.toFloat()

            for (point in points) {
                val geoPoint = GeoPoint(point.latitude, point.longitude)
                val screenPoint = mapView.projection.toPixels(geoPoint, null)
                val radiusPixels = metersToPixels(
                    meters = POINT_DIAMETER_METERS / 2.0,
                    latitude = point.latitude,
                    zoomLevel = mapView.zoomLevelDouble
                )
                val radius = radiusPixels.toFloat().coerceAtLeast(2f)

                if (screenPoint.x + radius < 0f ||
                    screenPoint.x - radius > width ||
                    screenPoint.y + radius < 0f ||
                    screenPoint.y - radius > height
                ) {
                    continue
                }

                canvas.drawCircle(
                    screenPoint.x.toFloat(),
                    screenPoint.y.toFloat(),
                    radius,
                    pointPaint
                )
            }
        }

        private fun metersToPixels(meters: Double, latitude: Double, zoomLevel: Double): Double {
            val metersPerPixel =
                156543.03392 * cos(Math.toRadians(latitude)) / 2.0.pow(zoomLevel)
            return if (metersPerPixel > 0.0) meters / metersPerPixel else meters
        }
    }

    private inner class FogOverlay : Overlay() {
        private val fogPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
        }

        private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT)
        }

        override fun draw(canvas: Canvas, mapView: MapView, shadow: Boolean) {
            if (shadow) return

            fogPaint.color = if (useBlackFog) {
                Color.argb(255, 0, 0, 0)
            } else {
                Color.argb(210, 215, 220, 225)
            }

            val layerId = canvas.saveLayer(
                0f,
                0f,
                mapView.width.toFloat(),
                mapView.height.toFloat(),
                null
            )

            canvas.drawRect(
                0f,
                0f,
                mapView.width.toFloat(),
                mapView.height.toFloat(),
                fogPaint
            )

            locationOverlay?.myLocation?.let { myLocation ->
                drawRevealCircle(
                    canvas = canvas,
                    mapView = mapView,
                    latitude = myLocation.latitude,
                    longitude = myLocation.longitude
                )
            }

            val boundingBox = mapView.boundingBox
            for (point in savedPointsOverlay.getPoints()) {
                if (!boundingBox.contains(point.latitude, point.longitude)) {
                    continue
                }

                drawRevealCircle(
                    canvas = canvas,
                    mapView = mapView,
                    latitude = point.latitude,
                    longitude = point.longitude
                )
            }

            canvas.restoreToCount(layerId)
        }

        private fun drawRevealCircle(
            canvas: Canvas,
            mapView: MapView,
            latitude: Double,
            longitude: Double
        ) {
            val geoPoint = GeoPoint(latitude, longitude)
            val screenPoint = mapView.projection.toPixels(geoPoint, null)
            val clearRadiusPixels = metersToPixels(
                meters = CLEAR_RADIUS_METERS,
                latitude = latitude,
                zoomLevel = mapView.zoomLevelDouble
            )
            val featherRadiusPixels = metersToPixels(
                meters = CLEAR_EDGE_FEATHER_METERS,
                latitude = latitude,
                zoomLevel = mapView.zoomLevelDouble
            )
            val outerRadiusPixels =
                (clearRadiusPixels + featherRadiusPixels).toFloat().coerceAtLeast(1f)

            if (screenPoint.x + outerRadiusPixels < 0f ||
                screenPoint.x - outerRadiusPixels > mapView.width.toFloat() ||
                screenPoint.y + outerRadiusPixels < 0f ||
                screenPoint.y - outerRadiusPixels > mapView.height.toFloat()
            ) {
                return
            }

            val innerStop =
                (clearRadiusPixels / (clearRadiusPixels + featherRadiusPixels))
                    .toFloat()
                    .coerceIn(0f, 1f)

            clearPaint.shader = RadialGradient(
                screenPoint.x.toFloat(),
                screenPoint.y.toFloat(),
                outerRadiusPixels,
                intArrayOf(
                    Color.argb(255, 0, 0, 0),
                    Color.argb(255, 0, 0, 0),
                    Color.argb(0, 0, 0, 0)
                ),
                floatArrayOf(0f, innerStop, 1f),
                Shader.TileMode.CLAMP
            )

            canvas.drawCircle(screenPoint.x.toFloat(), screenPoint.y.toFloat(), outerRadiusPixels, clearPaint)
            clearPaint.shader = null
        }

        private fun metersToPixels(meters: Double, latitude: Double, zoomLevel: Double): Double {
            val metersPerPixel =
                156543.03392 * cos(Math.toRadians(latitude)) / 2.0.pow(zoomLevel)
            return if (metersPerPixel > 0.0) meters / metersPerPixel else meters
        }
    }
}
