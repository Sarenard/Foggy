package com.example.foggy

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat

class LocationTrackingService : Service() {

    private lateinit var locationManager: LocationManager
    private lateinit var locationHistoryDatabase: LocationHistoryDatabase

    private val gpsLocationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            saveLocation(location)
        }
    }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        locationHistoryDatabase = LocationHistoryDatabase(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!hasFineLocationPermission()) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        updateTrackingState(this, true)
        requestLocationUpdates()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        updateTrackingState(this, false)
        stopTracking()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        updateTrackingState(this, false)
        stopTracking()
        locationHistoryDatabase.close()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun requestLocationUpdates() {
        if (!hasFineLocationPermission()) return

        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    LOCATION_SAVE_INTERVAL_MS,
                    0f,
                    gpsLocationListener,
                    Looper.getMainLooper()
                )
            }

            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    LOCATION_SAVE_INTERVAL_MS,
                    0f,
                    gpsLocationListener,
                    Looper.getMainLooper()
                )
            }
        } catch (_: IllegalArgumentException) {
        } catch (_: SecurityException) {
            stopSelf()
        }
    }

    private fun stopTracking() {
        try {
            locationManager.removeUpdates(gpsLocationListener)
        } catch (_: SecurityException) {
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun saveLocation(location: Location) {
        val recordedAt = if (location.time > 0L) location.time else System.currentTimeMillis()
        val altitude = if (location.hasAltitude()) location.altitude else 0.0
        val accuracy = if (location.hasAccuracy()) location.accuracy else 0f

        locationHistoryDatabase.insertPoint(
            latitude = location.latitude,
            longitude = location.longitude,
            altitude = altitude,
            accuracy = accuracy,
            recordedAt = recordedAt
        )
    }

    private fun buildNotification(): Notification {
        val intervalSeconds = (LOCATION_SAVE_INTERVAL_MS / 1_000L).toInt()
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.tracking_notification_title))
            .setContentText(getString(R.string.tracking_notification_text, intervalSeconds))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(openAppPendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        )
        manager.createNotificationChannel(channel)
    }

    private fun hasFineLocationPermission(): Boolean {
        return ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val CHANNEL_ID = "tracking_channel"
        private const val CHANNEL_NAME = "Tracking"
        private const val NOTIFICATION_ID = 1001
        private const val LOCATION_SAVE_INTERVAL_MS = 1_000L
        private const val PREFS_NAME = "tracking_prefs"
        private const val KEY_TRACKING_ACTIVE = "tracking_active"

        fun isTrackingActive(context: Context): Boolean {
            return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_TRACKING_ACTIVE, false)
        }

        fun updateTrackingState(context: Context, active: Boolean) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_TRACKING_ACTIVE, active)
                .apply()
        }
    }
}
