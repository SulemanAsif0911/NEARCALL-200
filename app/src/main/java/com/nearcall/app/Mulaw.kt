package com.nearcall.app

/** G.711 mu-law: 16-bit PCM <-> 8-bit, halves the bandwidth of voice. */
object Mulaw {
    private const val BIAS = 0x84
    private const val CLIP = 32635

    fun enc(s: Short): Byte {
        var x = s.toInt()
        val sign = if (x < 0) 0x80 else 0
        if (x < 0) x = -x
        if (x > CLIP) x = CLIP
        x += BIAS
        var exp = 7
        var mask = 0x4000
        while (exp > 0 && (x and mask) == 0) { exp--; mask = mask shr 1 }
        val mant = (x shr (exp + 3)) and 0x0F
        return (sign or (exp shl 4) or mant).inv().toByte()
    }

    fun dec(b: Byte): Short {
        val u = b.toInt().inv() and 0xFF
        val sign = u and 0x80
        val exp = (u shr 4) and 0x07
        val mant = u and 0x0F
        var x = ((mant shl 3) + BIAS) shl exp
        x -= BIAS
        return (if (sign != 0) -x else x).toShort()
    }
}
