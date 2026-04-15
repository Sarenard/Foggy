package com.example.foggy

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlin.math.atan
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.tan

class LocationHistoryDatabase(context: Context) : SQLiteOpenHelper(
    context,
    DATABASE_NAME,
    null,
    DATABASE_VERSION
) {

    data class StoredGridCell(
        val column: Long,
        val row: Long
    )

    data class StoredLocationPoint(
        val latitude: Double,
        val longitude: Double
    )

    data class StoredGridCellWithState(
        val column: Long,
        val row: Long,
        val editState: Int
    )

    override fun onCreate(db: SQLiteDatabase) {
        createGridCellsTable(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        var version = oldVersion

        while (version < newVersion) {
            when (version) {
                1 -> {
                    migrateLegacyGpsPointsToSingleCells(db)
                    version = 2
                }

                2 -> {
                    migrateSingleCellsToRevealedCells(db)
                    version = 3
                }

                3 -> {
                    addEditStateColumn(db)
                    version = 4
                }

                else -> {
                    db.execSQL("DROP TABLE IF EXISTS $TABLE_POINTS")
                    onCreate(db)
                    return
                }
            }
        }
    }

    fun insertPoint(
        latitude: Double,
        longitude: Double,
        altitude: Double,
        accuracy: Float,
        recordedAt: Long
    ) {
        val ignoredAltitude = altitude
        val ignoredAccuracy = accuracy
        if (ignoredAltitude.isNaN() || ignoredAccuracy.isNaN()) {
            return
        }

        val cells = revealedCellsAround(latitude, longitude)
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (cell in cells) {
                upsertGpsCell(db, cell, recordedAt)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun deleteNearPoint(latitude: Double, longitude: Double) {
        val cell = latLonToGridCell(latitude, longitude)
        val db = writableDatabase
        db.beginTransaction()
        try {
            applyEditDeletion(db, cell)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun deleteNearPointBulk(latitude: Double, longitude: Double) {
        val cells = revealedCellsAround(latitude, longitude)
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (cell in cells) {
                applyEditDeletion(db, cell)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun getAllPoints(): List<StoredLocationPoint> {
        return getAllCells().map(::gridCellToLatLon)
    }

    fun getAllCells(): List<StoredGridCell> {
        return getAllCellsWithState()
            .filter { it.editState != EDIT_STATE_REMOVED_BY_EDIT }
            .map { StoredGridCell(column = it.column, row = it.row) }
    }

    fun getAllCellsWithState(): List<StoredGridCellWithState> {
        val cells = mutableListOf<StoredGridCellWithState>()
        val query = """
            SELECT $COLUMN_GRID_COLUMN, $COLUMN_GRID_ROW, $COLUMN_EDIT_STATE
            FROM $TABLE_POINTS
            ORDER BY $COLUMN_RECORDED_AT ASC
        """.trimIndent()

        readableDatabase.rawQuery(query, null).use { cursor ->
            val columnIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_COLUMN)
            val rowIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_ROW)
            val editStateIndex = cursor.getColumnIndexOrThrow(COLUMN_EDIT_STATE)

            while (cursor.moveToNext()) {
                cells.add(
                    StoredGridCellWithState(
                        column = cursor.getLong(columnIndex),
                        row = cursor.getLong(rowIndex),
                        editState = cursor.getInt(editStateIndex)
                    )
                )
            }
        }

        return cells
    }

    fun gridCellToLatLon(column: Long, row: Long): StoredLocationPoint {
        return gridCellToLatLon(StoredGridCell(column = column, row = row))
    }

    fun getLastPoint(): StoredLocationPoint? {
        val query = """
            SELECT $COLUMN_GRID_COLUMN, $COLUMN_GRID_ROW
            FROM $TABLE_POINTS
            WHERE $COLUMN_EDIT_STATE != $EDIT_STATE_REMOVED_BY_EDIT
            ORDER BY $COLUMN_RECORDED_AT DESC
            LIMIT 1
        """.trimIndent()

        readableDatabase.rawQuery(query, null).use { cursor ->
            if (!cursor.moveToFirst()) return null

            val columnIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_COLUMN)
            val rowIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_ROW)
            return gridCellToLatLon(
                StoredGridCell(
                    column = cursor.getLong(columnIndex),
                    row = cursor.getLong(rowIndex)
                )
            )
        }
    }

    private fun createGridCellsTable(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_POINTS (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                $COLUMN_GRID_COLUMN INTEGER NOT NULL,
                $COLUMN_GRID_ROW INTEGER NOT NULL,
                $COLUMN_RECORDED_AT INTEGER NOT NULL,
                $COLUMN_EDIT_STATE INTEGER NOT NULL DEFAULT $EDIT_STATE_NORMAL,
                UNIQUE($COLUMN_GRID_COLUMN, $COLUMN_GRID_ROW)
            )
            """.trimIndent()
        )
    }

    private fun addEditStateColumn(db: SQLiteDatabase) {
        db.execSQL(
            """
            ALTER TABLE $TABLE_POINTS
            ADD COLUMN $COLUMN_EDIT_STATE INTEGER NOT NULL DEFAULT $EDIT_STATE_NORMAL
            """.trimIndent()
        )
    }

    private fun migrateLegacyGpsPointsToSingleCells(db: SQLiteDatabase) {
        recreateAsGridCells(db)

        db.rawQuery(
            """
            SELECT $COLUMN_LATITUDE, $COLUMN_LONGITUDE, $COLUMN_RECORDED_AT
            FROM ${TABLE_POINTS}_legacy
            ORDER BY $COLUMN_RECORDED_AT ASC
            """.trimIndent(),
            null
        ).use { cursor ->
            val latitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LATITUDE)
            val longitudeIndex = cursor.getColumnIndexOrThrow(COLUMN_LONGITUDE)
            val recordedAtIndex = cursor.getColumnIndexOrThrow(COLUMN_RECORDED_AT)

            while (cursor.moveToNext()) {
                insertGridCell(
                    db = db,
                    tableName = TABLE_POINTS,
                    cell = latLonToGridCell(
                        latitude = cursor.getDouble(latitudeIndex),
                        longitude = cursor.getDouble(longitudeIndex)
                    ),
                    recordedAt = cursor.getLong(recordedAtIndex)
                )
            }
        }

        db.execSQL("DROP TABLE IF EXISTS ${TABLE_POINTS}_legacy")
    }

    private fun migrateSingleCellsToRevealedCells(db: SQLiteDatabase) {
        recreateAsGridCells(db)

        db.rawQuery(
            """
            SELECT $COLUMN_GRID_COLUMN, $COLUMN_GRID_ROW, $COLUMN_RECORDED_AT
            FROM ${TABLE_POINTS}_legacy
            ORDER BY $COLUMN_RECORDED_AT ASC
            """.trimIndent(),
            null
        ).use { cursor ->
            val columnIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_COLUMN)
            val rowIndex = cursor.getColumnIndexOrThrow(COLUMN_GRID_ROW)
            val recordedAtIndex = cursor.getColumnIndexOrThrow(COLUMN_RECORDED_AT)

            while (cursor.moveToNext()) {
                val sourceCell = StoredGridCell(
                    column = cursor.getLong(columnIndex),
                    row = cursor.getLong(rowIndex)
                )
                val center = gridCellToLatLon(sourceCell)
                val recordedAt = cursor.getLong(recordedAtIndex)

                for (cell in revealedCellsAround(center.latitude, center.longitude)) {
                    insertGridCell(db, TABLE_POINTS, cell, recordedAt)
                }
            }
        }

        db.execSQL("DROP TABLE IF EXISTS ${TABLE_POINTS}_legacy")
    }

    private fun recreateAsGridCells(db: SQLiteDatabase) {
        db.beginTransaction()
        try {
            db.execSQL("ALTER TABLE $TABLE_POINTS RENAME TO ${TABLE_POINTS}_legacy")
            createGridCellsTable(db)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun insertGridCell(
        db: SQLiteDatabase,
        tableName: String,
        cell: StoredGridCell,
        recordedAt: Long,
        editState: Int = EDIT_STATE_NORMAL
    ) {
        val values = ContentValues().apply {
            put(COLUMN_GRID_COLUMN, cell.column)
            put(COLUMN_GRID_ROW, cell.row)
            put(COLUMN_RECORDED_AT, recordedAt)
            put(COLUMN_EDIT_STATE, editState)
        }

        db.insertWithOnConflict(
            tableName,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    private fun upsertGpsCell(
        db: SQLiteDatabase,
        cell: StoredGridCell,
        recordedAt: Long
    ) {
        when (getExistingEditState(db, cell)) {
            null -> insertGridCell(db, TABLE_POINTS, cell, recordedAt, EDIT_STATE_NORMAL)
            EDIT_STATE_NORMAL -> Unit
            EDIT_STATE_ADDED_BY_EDIT,
            EDIT_STATE_REMOVED_BY_EDIT -> updateCell(db, cell, recordedAt, EDIT_STATE_NORMAL)
            else -> Unit
        }
    }

    fun insertManualPoint(latitude: Double, longitude: Double) {
        val cell = latLonToGridCell(latitude, longitude)
        val recordedAt = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            applyEditInsertion(db, cell, recordedAt)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun insertManualPointBulk(latitude: Double, longitude: Double) {
        val cells = revealedCellsAround(latitude, longitude)
        val recordedAt = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (cell in cells) {
                applyEditInsertion(db, cell, recordedAt)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun applyEditInsertion(
        db: SQLiteDatabase,
        cell: StoredGridCell,
        recordedAt: Long
    ) {
        when (getExistingEditState(db, cell)) {
            null -> insertGridCell(db, TABLE_POINTS, cell, recordedAt, EDIT_STATE_ADDED_BY_EDIT)
            EDIT_STATE_NORMAL -> Unit
            EDIT_STATE_ADDED_BY_EDIT -> Unit
            EDIT_STATE_REMOVED_BY_EDIT -> updateCell(db, cell, recordedAt, EDIT_STATE_NORMAL)
            else -> Unit
        }
    }

    private fun applyEditDeletion(db: SQLiteDatabase, cell: StoredGridCell) {
        when (getExistingEditState(db, cell)) {
            null -> Unit
            EDIT_STATE_NORMAL -> updateCellEditState(db, cell, EDIT_STATE_REMOVED_BY_EDIT)
            EDIT_STATE_ADDED_BY_EDIT -> deleteCell(db, cell)
            EDIT_STATE_REMOVED_BY_EDIT -> Unit
            else -> Unit
        }
    }

    private fun getExistingEditState(db: SQLiteDatabase, cell: StoredGridCell): Int? {
        val query = """
            SELECT $COLUMN_EDIT_STATE
            FROM $TABLE_POINTS
            WHERE $COLUMN_GRID_COLUMN = ? AND $COLUMN_GRID_ROW = ?
            LIMIT 1
        """.trimIndent()

        db.rawQuery(query, arrayOf(cell.column.toString(), cell.row.toString())).use { cursor ->
            if (!cursor.moveToFirst()) return null
            return cursor.getInt(cursor.getColumnIndexOrThrow(COLUMN_EDIT_STATE))
        }
    }

    private fun updateCell(
        db: SQLiteDatabase,
        cell: StoredGridCell,
        recordedAt: Long,
        editState: Int
    ) {
        val values = ContentValues().apply {
            put(COLUMN_RECORDED_AT, recordedAt)
            put(COLUMN_EDIT_STATE, editState)
        }

        db.update(
            TABLE_POINTS,
            values,
            "$COLUMN_GRID_COLUMN = ? AND $COLUMN_GRID_ROW = ?",
            arrayOf(cell.column.toString(), cell.row.toString())
        )
    }

    private fun updateCellEditState(
        db: SQLiteDatabase,
        cell: StoredGridCell,
        editState: Int
    ) {
        val values = ContentValues().apply {
            put(COLUMN_EDIT_STATE, editState)
        }

        db.update(
            TABLE_POINTS,
            values,
            "$COLUMN_GRID_COLUMN = ? AND $COLUMN_GRID_ROW = ?",
            arrayOf(cell.column.toString(), cell.row.toString())
        )
    }

    private fun deleteCell(db: SQLiteDatabase, cell: StoredGridCell) {
        db.delete(
            TABLE_POINTS,
            "$COLUMN_GRID_COLUMN = ? AND $COLUMN_GRID_ROW = ?",
            arrayOf(cell.column.toString(), cell.row.toString())
        )
    }

    private fun revealedCellsAround(latitude: Double, longitude: Double): Set<StoredGridCell> {
        val pointX = longitudeToWebMercatorX(longitude)
        val pointY = latitudeToWebMercatorY(latitude)
        val minColumn = floor((pointX - REVEAL_RADIUS_METERS) / GRID_CELL_SIZE_METERS).toLong()
        val maxColumn = ceil((pointX + REVEAL_RADIUS_METERS) / GRID_CELL_SIZE_METERS).toLong()
        val minRow = floor((pointY - REVEAL_RADIUS_METERS) / GRID_CELL_SIZE_METERS).toLong()
        val maxRow = ceil((pointY + REVEAL_RADIUS_METERS) / GRID_CELL_SIZE_METERS).toLong()
        val revealedCells = mutableSetOf<StoredGridCell>()

        for (column in minColumn..maxColumn) {
            val cellLeft = column * GRID_CELL_SIZE_METERS
            val cellRight = cellLeft + GRID_CELL_SIZE_METERS

            for (row in minRow..maxRow) {
                val cellTop = row * GRID_CELL_SIZE_METERS
                val cellBottom = cellTop + GRID_CELL_SIZE_METERS
                val dx = when {
                    pointX < cellLeft -> cellLeft - pointX
                    pointX > cellRight -> pointX - cellRight
                    else -> 0.0
                }
                val dy = when {
                    pointY < cellTop -> cellTop - pointY
                    pointY > cellBottom -> pointY - cellBottom
                    else -> 0.0
                }

                if (dx * dx + dy * dy <= REVEAL_RADIUS_METERS * REVEAL_RADIUS_METERS) {
                    revealedCells.add(StoredGridCell(column = column, row = row))
                }
            }
        }

        return revealedCells
    }

    private fun latLonToGridCell(latitude: Double, longitude: Double): StoredGridCell {
        val x = longitudeToWebMercatorX(longitude)
        val y = latitudeToWebMercatorY(latitude)
        return StoredGridCell(
            column = floor(x / GRID_CELL_SIZE_METERS).toLong(),
            row = floor(y / GRID_CELL_SIZE_METERS).toLong()
        )
    }

    private fun gridCellToLatLon(cell: StoredGridCell): StoredLocationPoint {
        val centerX = (cell.column + 0.5) * GRID_CELL_SIZE_METERS
        val centerY = (cell.row + 0.5) * GRID_CELL_SIZE_METERS
        return StoredLocationPoint(
            latitude = webMercatorYToLatitude(centerY),
            longitude = webMercatorXToLongitude(centerX)
        )
    }

    private fun longitudeToWebMercatorX(longitude: Double): Double {
        return WEB_MERCATOR_HALF_WORLD_METERS * longitude / 180.0
    }

    private fun latitudeToWebMercatorY(latitude: Double): Double {
        val radians = Math.toRadians(latitude.coerceIn(-85.05112878, 85.05112878))
        return 6_378_137.0 * ln(tan(Math.PI / 4.0 + radians / 2.0))
    }

    private fun webMercatorXToLongitude(x: Double): Double {
        return (x / WEB_MERCATOR_HALF_WORLD_METERS) * 180.0
    }

    private fun webMercatorYToLatitude(y: Double): Double {
        val radians = 2.0 * atan(exp(y / 6_378_137.0)) - Math.PI / 2.0
        return Math.toDegrees(radians)
    }

    companion object {
        private const val DATABASE_NAME = "location_history.db"
        private const val DATABASE_VERSION = 4
        private const val GRID_CELL_SIZE_METERS = 15.0
        private const val REVEAL_RADIUS_METERS = 15.0
        private const val WEB_MERCATOR_HALF_WORLD_METERS = 20_037_508.342789244

        const val TABLE_POINTS = "gps_points"
        const val COLUMN_LATITUDE = "latitude"
        const val COLUMN_LONGITUDE = "longitude"
        const val COLUMN_RECORDED_AT = "recorded_at"
        const val COLUMN_GRID_COLUMN = "grid_column"
        const val COLUMN_GRID_ROW = "grid_row"
        const val COLUMN_EDIT_STATE = "edit_state"

        const val EDIT_STATE_NORMAL = 0
        const val EDIT_STATE_ADDED_BY_EDIT = 1
        const val EDIT_STATE_REMOVED_BY_EDIT = 2
    }
}
