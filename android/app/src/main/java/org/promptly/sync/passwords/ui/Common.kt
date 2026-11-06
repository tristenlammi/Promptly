package org.promptly.sync.passwords.ui

import android.os.Build
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.Toast
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.passwords.Biometrics
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.KeyChangedError
import org.promptly.sync.passwords.core.OfflineError
import org.promptly.sync.passwords.core.WrongPasswordError

private val Terracotta = Color(0xFFC8613F)

/** Same colours as the rest of the Promptly app. Test tags reach UI Automator as ids. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PwTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFFE38B6D), secondary = Color(0xFFE38B6D))
    } else {
        lightColorScheme(primary = Terracotta, secondary = Terracotta)
    }
    MaterialTheme(colorScheme = scheme) {
        Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }, color = MaterialTheme.colorScheme.background, content = content)
    }
}

fun errorText(e: Throwable): String = when (e) {
    is WrongPasswordError -> if (e.changedElsewhere) "That didn't open your vault, and your master password or Secret Key was changed on another device since this phone last unlocked." else "That master password isn't right."
    is OfflineError -> "The server can't be reached."
    is ApiError if e.status == 401 && e.detail != "vault_locked" -> "The server no longer knows this phone."
    is KeyChangedError -> e.message ?: "Someone's keys have changed."
    is ApiError -> when (e.status) {
        401 -> "Your session has ended. Try that again."
        403 -> e.detail ?: "The server won't allow that."
        429 -> "Too many tries. Wait ${e.retryAfter ?: 60} seconds and try again."
        else -> e.detail ?: "The server said no (${e.status})."
    }
    is OutOfMemoryError -> "This phone doesn't have enough free memory for this vault's settings."
    else -> e.message ?: "That didn't work."
}

/** Touches through an overlay don't count, and other apps' overlays go where Android allows. */
fun hardenWindow(activity: android.app.Activity) {
    activity.window.decorView.filterTouchesWhenObscured = true
    if (Build.VERSION.SDK_INT >= 31) activity.window.setHideOverlayWindows(true)
}

/** Asks the keyboard not to learn from what's typed in here. Compose has no option for it. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun NoKeyboardLearning(content: @Composable () -> Unit) {
    InterceptPlatformTextInput(
        interceptor = { request, next ->
            next.startInputMethod(object : PlatformTextInputMethodRequest {
                override fun createInputConnection(outAttributes: EditorInfo): InputConnection {
                    val connection = request.createInputConnection(outAttributes)
                    outAttributes.imeOptions = outAttributes.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                    return connection
                }
            })
        },
        content = content,
    )
}

private val sensitiveViews = java.util.WeakHashMap<View, Int>()

/** While a secret's on show, only accessibility tools can read this window (Android 14 on). */
@Composable
fun SensitiveWhile(shown: Boolean) {
    if (!shown || Build.VERSION.SDK_INT < 34) return
    val view = LocalView.current
    DisposableEffect(view) {
        sensitiveViews[view] = (sensitiveViews[view] ?: 0) + 1
        if (Build.VERSION.SDK_INT >= 34) view.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES)
        onDispose {
            val left = (sensitiveViews[view] ?: 1) - 1
            sensitiveViews[view] = left
            if (left <= 0 && Build.VERSION.SDK_INT >= 34) view.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_AUTO)
        }
    }
}

@Composable
fun SecretField(value: String, onChange: (String) -> Unit, label: String, tag: String, modifier: Modifier = Modifier.fillMaxWidth(), visible: Boolean = false) {
    SensitiveWhile(visible)
    NoKeyboardLearning {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            singleLine = true,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = modifier.testTag(tag),
        )
    }
}

/** A secret that's easier to get right when you can read it: a Secret Key, a 2FA secret, a
 *  private key. Shown, but typed like a password, and kept out of what the keyboard learns. */
@Composable
fun VisibleSecretField(value: String, onChange: (String) -> Unit, label: String, tag: String, modifier: Modifier = Modifier.fillMaxWidth(), singleLine: Boolean = true, minLines: Int = 1) {
    SensitiveWhile(value.isNotEmpty())
    NoKeyboardLearning {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            singleLine = singleLine,
            minLines = minLines,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = modifier.testTag(tag),
        )
    }
}

@Composable
fun ErrorCard(text: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), modifier = Modifier.fillMaxWidth()) {
        Text(text, Modifier.padding(12.dp).testTag("error"), color = MaterialTheme.colorScheme.onErrorContainer)
    }
}

@Composable
fun PreviewNote() {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer), modifier = Modifier.fillMaxWidth().testTag("preview-note")) {
        Text(
            "Preview. Passwords hasn't finished its real-phone checks or an outside security review, so don't rely on it for important passwords yet.",
            Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

/** Master password, with a biometric if it's set up. Shared by the app and the autofill
 *  and passkey sheets, so they unlock exactly the same way. */
@Composable
fun UnlockPane(activity: FragmentActivity, heading: String, onUnlocked: () -> Unit, onCancel: (() -> Unit)? = null) {
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var removed by remember { mutableStateOf(false) }
    var rotatedOut by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val canBio = Biometrics.enrolled && Biometrics.available(ctx)

    fun biometric() {
        error = null
        Biometrics.unlock(activity) { r ->
            r.onSuccess { secret ->
                busy = true
                scope.launch {
                    val done = withContext(Dispatchers.IO) { runCatching { Pw.client()!!.unlockWithSecret(secret) } }
                    secret.fill(0)
                    busy = false
                    done.onSuccess {
                        Pw.touch()
                        onUnlocked()
                    }.onFailure {
                        // The password changed on another device: these keys are the old ones.
                        if (it is WrongPasswordError) {
                            Biometrics.forget()
                            error = "Your master password has changed. Unlock with the new one, then turn biometric unlock on again."
                        } else {
                            if (it is ApiError && it.status == 401) removed = true
                            error = errorText(it)
                        }
                    }
                }
            }.onFailure { e ->
                if (!(e is Biometrics.Failed && e.cancelled)) error = e.message
            }
        }
    }

    fun submit() {
        if (password.isEmpty() || busy) return
        busy = true
        error = null
        scope.launch {
            val done = withContext(Dispatchers.IO) { runCatching { Pw.client()!!.unlock(password) } }
            busy = false
            done.onSuccess {
                password = ""
                Pw.touch()
                onUnlocked()
            }.onFailure {
                // /session answers wrong proofs as WrongPasswordError, so a 401 here is the
                // device token itself: removed in Devices, or "sign out everywhere".
                if (it is ApiError && it.status == 401) removed = true
                if (it is WrongPasswordError && it.changedElsewhere) rotatedOut = true
                error = errorText(it)
            }
        }
    }

    LaunchedEffect(Unit) { if (canBio) biometric() }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(heading, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        SecretField(password, { password = it }, "Master password", "master-password")
        error?.let { ErrorCard(it) }
        if (rotatedOut) {
            Text("If it was the master password, try the new one. If the Secret Key was changed, this phone holds the old one, and has to join again with your new kit or another device.", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = {
                Pw.forgetSecretKey()
                onUnlocked()
            }, modifier = Modifier.testTag("rejoin")) { Text("Join this phone again") }
        }
        if (removed) {
            Text("This phone was removed from your account, or you signed out everywhere. Its encrypted copy is still here.", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = {
                // Back to connecting. The Secret Key and the offline copy stay.
                Pw.disconnect()
                onUnlocked()
            }, modifier = Modifier.testTag("connect-again")) { Text("Connect this phone again") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { submit() }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.testTag("unlock")) { Text("Unlock") }
            if (canBio) OutlinedButton(onClick = { biometric() }, enabled = !busy, modifier = Modifier.testTag("use-biometric")) { Text("Use biometric") }
            if (onCancel != null) TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.testTag("unlock-cancel")) { Text("Cancel") }
            if (busy) CircularProgressIndicator(Modifier.padding(start = 4.dp))
        }
    }
}

/** Ask again for one item (the item's "reprompt" setting, or before signing a passkey):
 *  a biometric if it's set up, otherwise the master password, checked locally. */
@Composable
fun ConfirmIdentityPane(activity: FragmentActivity, heading: String, detail: String?, biometricFirst: Boolean, onConfirmed: () -> Unit, onCancel: () -> Unit) {
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    // Only with the key that dies when a new fingerprint's added. Without it, the password.
    var canBio by remember { mutableStateOf(biometricFirst && Biometrics.enrolled && Biometrics.available(ctx)) }

    fun bio() {
        Biometrics.confirm(activity, heading, detail) { r ->
            if (r.exceptionOrNull() is Biometrics.Invalidated) canBio = false
            r.onSuccess { onConfirmed() }.onFailure { e -> if (!(e is Biometrics.Failed && e.cancelled)) error = e.message }
        }
    }
    LaunchedEffect(Unit) { if (canBio) bio() }

    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(heading, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        SecretField(password, { password = it }, "Master password", "confirm-password")
        error?.let { ErrorCard(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val ok = withContext(Dispatchers.IO) { Pw.client()?.checkPassword(password) == true }
                        busy = false
                        if (ok) onConfirmed() else error = "That master password isn't right."
                    }
                },
                enabled = !busy && password.isNotEmpty(),
                modifier = Modifier.testTag("confirm"),
            ) { Text("Confirm") }
            if (canBio) OutlinedButton(onClick = { bio() }, modifier = Modifier.testTag("use-biometric")) { Text("Use biometric") }
            TextButton(onClick = onCancel, modifier = Modifier.testTag("cancel")) { Text("Cancel") }
            if (busy) CircularProgressIndicator(Modifier.padding(start = 4.dp))
        }
    }
}

fun toast(activity: android.content.Context, text: String) = Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
