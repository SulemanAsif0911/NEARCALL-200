package com.nearcall.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the mesh service after a reboot if the user had it running. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        val p = MeshService.prefs(c)
        if (p.getBoolean("auto", false) && p.getString("num", "").orEmpty().isNotEmpty() && Perms.hasNearby(c)) {
            try { MeshService.start(c) } catch (_: Exception) {}
        }
    }
}
