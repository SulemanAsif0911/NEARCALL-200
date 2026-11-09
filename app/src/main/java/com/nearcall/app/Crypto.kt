package com.nearcall.app

import android.content.SharedPreferences
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end encryption helpers.
 * Every install has an EC (secp256r1) key pair. Two phones derive the same AES key with ECDH,
 * so only the sender and the receiver can read a message; relay phones only see ciphertext.
 */
class Crypto(p: SharedPreferences) {
    private val rng = SecureRandom()
    private val kf = KeyFactory.getInstance("EC")
    private val priv: PrivateKey
    val pubB64: String
    private val cache = HashMap<String, ByteArray>()

    init {
        val sp = p.getString("kpub", null)
        val sr = p.getString("kprv", null)
        val pubS: String
        val prvS: String
        if (sp != null && sr != null) {
            pubS = sp
            prvS = sr
        } else {
            val g = KeyPairGenerator.getInstance("EC")
            g.initialize(ECGenParameterSpec("secp256r1"), rng)
            val kp = g.generateKeyPair()
            pubS = Base64.encodeToString(kp.public.encoded, Base64.NO_WRAP)
            prvS = Base64.encodeToString(kp.private.encoded, Base64.NO_WRAP)
            p.edit().putString("kpub", pubS).putString("kprv", prvS).apply()
        }
        pubB64 = pubS
        priv = kf.generatePrivate(PKCS8EncodedKeySpec(Base64.decode(prvS, Base64.NO_WRAP)))
    }

    /** Shared 32-byte key between us and the owner of `peerPubB64`, or null if the key is invalid. */
    fun shared(peerPubB64: String): ByteArray? {
        if (peerPubB64.isEmpty()) return null
        return synchronized(cache) {
            val hit = cache[peerPubB64]
            if (hit != null) {
                hit
            } else {
                try {
                    val pub = kf.generatePublic(X509EncodedKeySpec(Base64.decode(peerPubB64, Base64.NO_WRAP)))
                    val ka = KeyAgreement.getInstance("ECDH")
                    ka.init(priv)
                    ka.doPhase(pub, true)
                    val md = MessageDigest.getInstance("SHA-256")
                    md.update(ka.generateSecret())
                    md.update("nearcall-v1".toByteArray())
                    val k = md.digest()
                    cache[peerPubB64] = k
                    k
                } catch (e: Exception) {
                    null
                }
            }
        }
    }

    /** ECDSA signature (DER) with this install's private key. */
    fun sign(data: ByteArray): ByteArray {
        val s = java.security.Signature.getInstance("SHA256withECDSA")
        s.initSign(priv)
        s.update(data)
        return s.sign()
    }

    /** Checks a signature made by the owner of `pkB64`. */
    fun verify(pkB64: String, data: ByteArray, sigB64: String): Boolean = try {
        val pub = kf.generatePublic(X509EncodedKeySpec(Base64.decode(pkB64, Base64.NO_WRAP)))
        val s = java.security.Signature.getInstance("SHA256withECDSA")
        s.initVerify(pub)
        s.update(data)
        s.verify(Base64.decode(sigB64, Base64.NO_WRAP))
    } catch (e: Exception) {
        false
    }

    /** AES-GCM with a random IV. Output = iv(12) + ciphertext + tag(16). */
    fun seal(key: ByteArray, plain: ByteArray): ByteArray {
        val iv = ByteArray(12)
        rng.nextBytes(iv)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return iv + c.doFinal(plain)
    }

    fun open(key: ByteArray, data: ByteArray): ByteArray? {
        if (data.size < 28) return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, data.copyOfRange(0, 12)))
            c.doFinal(data, 12, data.size - 12)
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        private fun sha(s: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())

        fun norm(name: String) = name.trim().lowercase()

        /** Channels: anyone who knows the name (and the password, if there is one) can read it. */
        fun channelKey(name: String, pass: String = ""): ByteArray =
            sha("nearcall-channel:" + norm(name) + (if (pass.isEmpty()) "" else ":$pass"))

        /** Short id that is derived from the public key itself (12 hex). Nobody can use it without the key. */
        fun fp(pkB64: String): String = try {
            val d = MessageDigest.getInstance("SHA-256").digest(Base64.decode(pkB64, Base64.NO_WRAP))
            val sb = StringBuilder()
            for (i in 0 until 6) sb.append("%02x".format(d[i].toInt() and 255))
            sb.toString()
        } catch (e: Exception) {
            ""
        }

        fun tag(name: String): String {
            val d = sha("tag:" + norm(name))
            val sb = StringBuilder()
            for (i in 0 until 4) sb.append("%02x".format(d[i].toInt() and 255))
            return sb.toString()
        }

        /** Per-call voice key so a new call never reuses a key/IV pair. */
        fun voiceKey(shared: ByteArray, cid: String): ByteArray {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(shared)
            md.update("voice".toByteArray())
            md.update(cid.toByteArray())
            return md.digest()
        }

        fun sealIv(key: ByteArray, iv: ByteArray, plain: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            return c.doFinal(plain)
        }

        fun openIv(key: ByteArray, iv: ByteArray, data: ByteArray, off: Int, len: Int): ByteArray? = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            c.doFinal(data, off, len)
        } catch (e: Exception) {
            null
        }
    }
}
