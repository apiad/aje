package aje.app

import android.app.Application

class AjeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
        Telemetry.init(this)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Store.saveCrash(error.stackTraceToString())
            previous?.uncaughtException(thread, error)
        }
        Store.takeCrash()?.let { Telemetry.event("crash", "stack" to it.take(4000)) }
        Telemetry.event("app_start")
    }
}
