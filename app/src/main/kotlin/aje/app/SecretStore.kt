package aje.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import java.util.Date
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val PREFS = "secrets"
private const val AUTHENTICATORS = BIOMETRIC_STRONG or DEVICE_CREDENTIAL
private const val DAY_MS = 86_400_000L

/**
 * Secrets the person asked the app to keep (the bank PIN). Each one is encrypted with its own
 * AES key in the Android Keystore; the key needs the fingerprint or the screen lock on every use
 * and stops working at its expiry, when the entry is also dropped. Only ciphertext touches disk.
 * Android 11 and later: before that a key bound to the screen lock cannot back a crypto prompt.
 */
object SecretStore {
    fun available(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            BiometricManager.from(context).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS

    fun status(context: Context, name: String): JSONObject {
        val expiresAt = entry(context, name)?.expiresAt
        return JSONObject()
            .put("available", available(context))
            .put("saved", expiresAt != null)
            .put("expiresAt", expiresAt ?: JSONObject.NULL)
    }

    fun save(activity: FragmentActivity, name: String, value: String, days: Int, done: (Boolean) -> Unit) {
        if (!available(activity)) return done(false)
        val expiresAt = System.currentTimeMillis() + days * DAY_MS
        val cipher = try {
            forget(activity, name)
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newKey(name, expiresAt)) }
        } catch (_: Exception) {
            return done(false)
        }
        prompt(activity, "Guardar la clave del banco", cipher) { c ->
            if (c == null) return@prompt done(false)
            val ct = c.doFinal(value.toByteArray())
            prefs(activity).edit().putString(name, "${b64(c.iv)}:${b64(ct)}:$expiresAt").apply()
            done(true)
        }
    }

    fun load(activity: FragmentActivity, name: String, done: (String?) -> Unit) {
        val e = entry(activity, name) ?: return done(null)
        val cipher = try {
            val key = keystore().getKey(alias(name), null) as SecretKey
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, e.iv)) }
        } catch (_: Exception) {
            // A new fingerprint or a removed screen lock invalidates the key: the PIN is gone.
            forget(activity, name)
            return done(null)
        }
        prompt(activity, "Usar la clave guardada", cipher) { c -> done(c?.doFinal(e.ct)?.decodeToString()) }
    }

    fun forget(context: Context, name: String) {
        prefs(context).edit().remove(name).apply()
        try {
            keystore().deleteEntry(alias(name))
        } catch (_: Exception) {
        }
    }

    private class Entry(val iv: ByteArray, val ct: ByteArray, val expiresAt: Long)

    // An expired or unreadable entry is dropped on sight.
    private fun entry(context: Context, name: String): Entry? {
        val parts = prefs(context).getString(name, null)?.split(":") ?: return null
        val e = try {
            Entry(unb64(parts[0]), unb64(parts[1]), parts[2].toLong())
        } catch (_: Exception) {
            null
        }
        if (e == null || e.expiresAt <= System.currentTimeMillis()) {
            forget(context, name)
            return null
        }
        return e
    }

    private fun newKey(name: String, expiresAt: Long): SecretKey {
        val spec = KeyGenParameterSpec.Builder(alias(name), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setKeyValidityEnd(Date(expiresAt))
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()
    }

    /** Shows the system prompt; `then` gets the unlocked cipher, or null when the person cancels. */
    private fun prompt(activity: FragmentActivity, title: String, cipher: Cipher, then: (Cipher?) -> Unit) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                try {
                    then(c)
                } catch (_: Exception) {
                    then(null)
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = then(null)
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle("Ajé")
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun keystore() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    private fun alias(name: String) = "aje.secret.$name"
    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)
}
