package com.example.foggy

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class LocationHistoryDatabase(context: Context) : SQLiteOpenHelper(
    context,
    DATABASE_NAME,
    null,
    DATABASE_VERSION
) {

    data class StoredLocationPoint(
        val latitude: Double,
        val longitude: Double
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_POINTS (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                altitude REAL NOT NULL,
                accuracy REAL NOT NULL,
                recorded_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE_POINTS")
        onCreate(db)
    }

    fun insertPoint(
        latitude: Double,
        longitude: Double,
        altitude: Double,
        accuracy: Float,
        recordedAt: Long
    ) {
        val values = ContentValues().apply {
            put(COLUMN_LATITUDE, latitude)
            put(COLUMN_LONGITUDE, longitude)
            put(COLUMN_ALTITUDE, altitude)
            put(COLUMN_ACCURACY, accuracy)
            put(COLUMN_RECORDED_AT, recordedAt)
        }

        writableDatabase.insert(TABLE_POINTS, null, values)
    }

    fun getAllPoints(): List<StoredLocationPoint> {
        val points = mutableListOf<StoredLocationPoint>()
        val query = """
            SELECT $COLUMN_LATITUDE, $COLUMN_LONGITUDE
            FROM $TABLE_POINTS
            ORDER BY $COLUMN_RECORDED_AT ASC
        """.trimIndent()

        readableDatabase.rawQuery(query, null).use { cursor ->
            val latitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LATITUDE)
            val longitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LONGITUDE)

            while (cursor.moveToNext()) {
                points.add(
                    StoredLocationPoint(
                        latitude = cursor.getDouble(latitudeIndex),
                        longitude = cursor.getDouble(longitudeIndex)
                    )
                )
            }
        }

        return points
    }

    fun getLastPoint(): StoredLocationPoint? {
        val query = """
            SELECT $COLUMN_LATITUDE, $COLUMN_LONGITUDE
            FROM $TABLE_POINTS
            ORDER BY $COLUMN_RECORDED_AT DESC
            LIMIT 1
        """.trimIndent()

        readableDatabase.rawQuery(query, null).use { cursor ->
            if (!cursor.moveToFirst()) return null

            val latitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LATITUDE)
            val longitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LONGITUDE)

            return StoredLocationPoint(
                latitude = cursor.getDouble(latitudeIndex),
                longitude = cursor.getDouble(longitudeIndex)
            )
        }
    }

    companion object {
        private const val DATABASE_NAME = "location_history.db"
        private const val DATABASE_VERSION = 1

        const val TABLE_POINTS = "gps_points"
        const val COLUMN_LATITUDE = "latitude"
        const val COLUMN_LONGITUDE = "longitude"
        const val COLUMN_ALTITUDE = "altitude"
        const val COLUMN_ACCURACY = "accuracy"
        const val COLUMN_RECORDED_AT = "recorded_at"
    }
}
