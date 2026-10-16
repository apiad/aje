package aje.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.telephony.SubscriptionManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import aje.core.money.Account
import aje.core.money.Bank
import aje.core.money.BankCard
import aje.core.money.Currency
import aje.core.money.MobileLine
import aje.core.money.MobilePlan
import aje.core.money.Pan
import aje.core.ops.BankOps
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val Settle = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private val River = Color(0xFF7FB59A)

private val Dark = darkColorScheme(
    background = Color(0xFF120D07), surface = Color(0xFF1E160C), primary = Color(0xFFE8B765),
    onPrimary = Color(0xFF160F04), onBackground = Color(0xFFEFE4D2), onSurface = Color(0xFFEFE4D2),
    outline = Color(0xFF3A2C18), onSurfaceVariant = Color(0xFFA4906F),
)
private val Light = lightColorScheme(
    background = Color(0xFFF7F1E6), surface = Color(0xFFFFFFFF), primary = Color(0xFF9A6B1F),
    onPrimary = Color(0xFFFFFFFF), onBackground = Color(0xFF2A1F12), onSurface = Color(0xFF2A1F12),
    outline = Color(0xFFE2D6C2), onSurfaceVariant = Color(0xFF7A6548),
)

private val PERMISSIONS = arrayOf(
    Manifest.permission.CALL_PHONE,
    Manifest.permission.READ_PHONE_STATE,
    Manifest.permission.RECEIVE_SMS,
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { Home() }
            }
        }
    }
}

private fun granted(context: Context) =
    PERMISSIONS.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

private data class Sim(val subId: Int, val slot: Int, val label: String)

@SuppressLint("MissingPermission")
private fun sims(context: Context): List<Sim> = try {
    context.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty().map {
        Sim(it.subscriptionId, it.simSlotIndex, "SIM ${it.simSlotIndex + 1} · ${it.carrierName}")
    }
} catch (_: SecurityException) {
    emptyList()
}

/** The deck's accounts: a bank card per enabled currency, then a phone line per active SIM. */
private fun accounts(context: Context): List<Account> {
    val cards = listOf(Currency.CUP, Currency.CUC, Currency.USD)
        .filter { it in Store.enabledCurrencies }
        .map { BankCard(Store.bank, it) }
    val lines = sims(context).map { MobileLine(it.subId, it.slot, it.label, Store.planFor(it.subId)) }
    return cards + lines
}

private enum class Screen(val label: String) {
    INICIO("Inicio"), PAGAR("Pagar"), QR("QR"), HISTORIAL("Historial"), AJUSTES("Ajustes")
}

@Composable
private fun Home() {
    val context = LocalContext.current
    var hasPermissions by remember { mutableStateOf(granted(context)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasPermissions = granted(context)
        Telemetry.event("permissions", "ok" to hasPermissions)
    }
    val scheme = MaterialTheme.colorScheme

    if (!hasPermissions) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Ajé", color = scheme.primary, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
            Panel {
                Text("Ajé necesita tres permisos", fontWeight = FontWeight.SemiBold)
                Text(
                    "Llamadas, para enviar el código USSD a tu banco. Estado del teléfono, para elegir la SIM. " +
                        "SMS, para leer la confirmación del banco.",
                    color = scheme.onSurfaceVariant, fontSize = 14.sp,
                )
                Button(onClick = { ask.launch(PERMISSIONS) }) { Text("Dar permisos") }
            }
        }
        return
    }

    var screen by remember { mutableStateOf(Screen.INICIO) }
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Box(Modifier.weight(1f)) {
            when (screen) {
                Screen.INICIO -> Inicio()
                Screen.PAGAR -> Proximamente("Pagar un servicio", "Electricidad, agua, teléfono y más, desde tu tarjeta.")
                Screen.QR -> Proximamente("Pagar y cobrar por QR", "Tu QR para que te transfieran, y leer el de otro para pagar.")
                Screen.HISTORIAL -> HistorialScreen()
                Screen.AJUSTES -> Ajustes()
            }
        }
        BottomNav(screen) { screen = it }
    }
}

@Composable
private fun Inicio() {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val accts = accounts(context)
    var front by remember(accts.size) { mutableStateOf(0) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Hola", color = scheme.onBackground, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        if (accts.isEmpty()) {
            Panel { Text("No hay cuentas. Habilita monedas o una SIM en Ajustes.", color = scheme.onSurfaceVariant) }
            return@Column
        }
        Deck(accts, front, onFront = { front = it })
        when (val a = accts.getOrNull(front.coerceIn(0, accts.lastIndex))) {
            is BankCard -> BankActions(a)
            is MobileLine -> MobileActions(a)
            else -> {}
        }
        RecentActivity()
    }
}

private class QuickAction(val label: String, val enabled: Boolean, val run: () -> Unit)

@Composable
private fun QuickActions(items: List<QuickAction>, onSoon: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        items.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                row.forEach { qa -> QuickActionButton(qa, Modifier.weight(1f), onSoon) }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun QuickActionButton(qa: QuickAction, modifier: Modifier, onSoon: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier.clip(RoundedCornerShape(14.dp)).background(scheme.surface)
            .clickable { if (qa.enabled) qa.run() else onSoon() }
            .padding(vertical = 12.dp, horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(qa.label, color = if (qa.enabled) scheme.onSurface else scheme.onSurfaceVariant, fontSize = 11.sp, textAlign = TextAlign.Center)
        if (!qa.enabled) Text("próximamente", color = scheme.onSurfaceVariant, fontSize = 9.sp)
    }
}

@Composable
private fun BankActions(card: BankCard) {
    val context = LocalContext.current
    var transferring by remember(card) { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    QuickActions(
        listOf(
            QuickAction("Ver saldo", true) { Ops.balance(context, card.currency); note = null },
            QuickAction("Transferir", true) { transferring = !transferring; note = null },
            QuickAction("Pagar servicio", false) {},
            QuickAction("Cobrar/Pagar QR", false) {},
            QuickAction("Caja Extra", false) {},
            QuickAction("Tipo de cambio", false) {},
        ),
    ) { note = "Esa operación llega en un incremento próximo." }
    note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp) }

    val latest = Store.attempts.firstOrNull { it.op == "46" && it.currency == card.currency.name }
    if (latest != null) {
        Panel {
            AttemptView(latest, expanded = true)
            if (latest.state != AttemptState.VERIFIED && latest.reply?.let(BankOps::needsLogin) == true) LoginAndRetry(card.currency)
        }
    }
    if (transferring) TransferForm(card.currency)
}

@Composable
private fun MobileActions(line: MobileLine) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    var reply by remember(line) { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    QuickActions(
        listOf(
            QuickAction("Saldo móvil", true) { note = null; Ops.mobileBalance(context, line) { reply = it } },
            QuickAction("Datos / cuota", false) {},
            QuickAction("Recargar", false) {},
            QuickAction("Comprar plan", false) {},
        ),
    ) { note = "Esa operación llega en un incremento próximo." }
    note?.let { Text(it, color = scheme.onSurfaceVariant, fontSize = 13.sp) }
    reply?.let {
        Panel {
            Text("Respuesta de ${line.balanceCode}", fontWeight = FontWeight.SemiBold)
            Text(it, fontSize = 14.sp)
        }
    }
}

@Composable
private fun RecentActivity() {
    val scheme = MaterialTheme.colorScheme
    if (Store.attempts.isEmpty()) return
    Panel {
        Text("Actividad reciente", fontWeight = FontWeight.SemiBold)
        Store.attempts.take(6).forEach { AttemptView(it, expanded = false) }
    }
}

@Composable
private fun Proximamente(title: String, sub: String) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, color = scheme.onBackground, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Panel {
            Text("Próximamente", color = scheme.primary, fontWeight = FontWeight.SemiBold)
            Text(sub, color = scheme.onSurfaceVariant, fontSize = 14.sp)
        }
    }
}

@Composable
private fun HistorialScreen() {
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Historial", color = scheme.onBackground, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        if (Store.attempts.isEmpty()) Panel { Text("Nada todavía.", color = scheme.onSurfaceVariant) }
        else Panel { Store.attempts.forEach { AttemptView(it, expanded = false) } }
    }
}

@Composable
private fun BottomNav(current: Screen, onPick: (Screen) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column {
        Box(Modifier.fillMaxWidth().height(1.dp).background(scheme.outline))
        Row(Modifier.fillMaxWidth().background(scheme.background).padding(vertical = 8.dp)) {
            Screen.entries.forEach { s ->
                Column(
                    Modifier.weight(1f).clickable { onPick(s) }.padding(vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(s.label, color = if (s == current) scheme.primary else scheme.onSurfaceVariant, fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(scheme.surface).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

@Composable
private fun Chips(options: List<Pair<String, Boolean>>, onPick: (Int) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { i, (label, selected) ->
            val bg by animateColorAsState(if (selected) scheme.primary else scheme.background, tween(300, easing = Settle), label = "chip")
            val fg by animateColorAsState(if (selected) scheme.onPrimary else scheme.onSurface, tween(300, easing = Settle), label = "chipText")
            Text(
                label, color = fg, fontSize = 14.sp,
                modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(bg).clickable { onPick(i) }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun Ajustes() {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val list = remember { sims(context) }
    if (Store.subId < 0 && list.size == 1) {
        Store.subId = list[0].subId
        Store.saveSettings()
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Ajustes", color = scheme.onBackground, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Panel {
            Text("La SIM registrada en el banco", fontWeight = FontWeight.SemiBold)
            if (list.isEmpty()) Text("No veo ninguna SIM activa.", color = scheme.onSurfaceVariant)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                list.forEach { sim ->
                    Chips(listOf(sim.label to (Store.subId == sim.subId))) {
                        Store.subId = sim.subId
                        Store.saveSettings()
                    }
                }
            }
            Text("Banco", fontWeight = FontWeight.SemiBold)
            val banks = listOf(Bank.METROPOLITANO, Bank.BPA, Bank.BANDEC)
            Chips(banks.map { (if (it == Bank.METROPOLITANO) "Metropolitano" else it.displayName) to (Store.bank == it) }) {
                Store.bank = banks[it]
                Store.saveSettings()
            }
            Text("Monedas de tus tarjetas", fontWeight = FontWeight.SemiBold)
            val currencies = listOf(Currency.CUP, Currency.CUC, Currency.USD)
            Chips(currencies.map { (if (it == Currency.USD) "USD / MLC" else it.name) to (it in Store.enabledCurrencies) }) {
                val c = currencies[it]
                val next = if (c in Store.enabledCurrencies) Store.enabledCurrencies - c else Store.enabledCurrencies + c
                if (next.isNotEmpty()) {
                    Store.enabledCurrencies = next
                    if (Store.currency !in next) Store.currency = next.first()
                    Store.saveSettings()
                }
            }
        }
        if (list.isNotEmpty()) {
            Panel {
                Text("Saldo de cada línea", fontWeight = FontWeight.SemiBold)
                Text("Prepago marca *222#; pospago (empresarial) marca *111#.", color = scheme.onSurfaceVariant, fontSize = 13.sp)
                list.forEach { sim ->
                    Text(sim.label, fontSize = 13.sp)
                    val plan = Store.planFor(sim.subId)
                    Chips(listOf("Prepago" to (plan == MobilePlan.PREPAGO), "Pospago" to (plan == MobilePlan.POSPAGO))) {
                        Store.setPlan(sim.subId, if (it == 0) MobilePlan.PREPAGO else MobilePlan.POSPAGO)
                    }
                }
            }
        }
        Login()
        TelemetryPanel()
        Diagnostics()
        TelemetryHistory()
        Text("Ajé ${BuildConfig.VERSION_NAME} · dev", color = scheme.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
}

/** The bank closed the session: ask for the key here, log in, and rerun the query when the auth SMS arrives. */
@Composable
private fun LoginAndRetry(currency: Currency) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    var status by remember { mutableStateOf<String?>(null) }
    if (Store.retryBalanceAfterLogin) {
        Text("Esperando el SMS de sesión abierta. Al llegar, Ajé vuelve a consultar.", color = scheme.primary, fontSize = 13.sp)
        TextButton(onClick = { Store.retryBalanceAfterLogin = false }) { Text("No llega: volver a escribir la clave", fontSize = 13.sp) }
    } else {
        Text("La sesión en el banco se cerró. Escribe tu clave y Ajé vuelve a consultar.", color = scheme.primary, fontSize = 13.sp)
        PinField { pin ->
            Store.retryBalanceAfterLogin = true
            Store.currency = currency
            Ops.login(context, pin) { status = it }
        }
    }
    status?.let { Text(it, fontSize = 13.sp, color = scheme.onSurfaceVariant) }
}

/** A 4-digit key field and its button. The key lives only in this field until it is sent. */
@Composable
private fun PinField(label: String = "Autenticarse", onSubmit: (String) -> Unit) {
    var pin by remember { mutableStateOf("") }
    OutlinedTextField(
        value = pin,
        onValueChange = { v -> pin = v.filter { it.isDigit() }.take(4) },
        label = { Text("Clave") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
    )
    Button(enabled = pin.length == 4, onClick = {
        val p = pin
        pin = ""
        onSubmit(p)
    }) { Text(label) }
}

@Composable
private fun TransferForm(currency: Currency) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    var card by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }
    val latest = Store.attempts.firstOrNull { it.op == "45" }
    val to = card.takeIf { it.length == 16 }?.let { Pan(it) }
    val units = amount.toLongOrNull()?.takeIf { it > 0 }

    Panel {
        Text("Transferir desde ${currency.name}", fontWeight = FontWeight.SemiBold)
        Text(
            "A otra tarjeta. Se abre el marcador y el banco te pide escribir 1 para confirmar. " +
                "El SMS de la transferencia la verifica.",
            color = scheme.onSurfaceVariant, fontSize = 13.sp,
        )
        if (Store.authenticatedAt == null) {
            Text("Abre sesión en el banco antes (en Ajustes): el marcador no le deja a Ajé ver si el banco la pide.", color = scheme.primary, fontSize = 13.sp)
        }
        OutlinedTextField(
            value = card,
            onValueChange = { v -> card = v.filter { it.isDigit() }.take(16); confirming = false },
            label = { Text("Tarjeta de destino, 16 dígitos") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        OutlinedTextField(
            value = amount,
            onValueChange = { v -> amount = v.filter { it.isDigit() }.take(7); confirming = false },
            label = { Text("Monto en ${currency.name}, sin centavos") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        if (to != null && units != null) {
            if (!confirming) {
                Button(onClick = { confirming = true }) { Text("Revisar") }
            } else {
                Text("Vas a transferir $units ${currency.name} a la tarjeta ${to.digits.chunked(4).joinToString(" ")}.", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = {
                        Ops.transfer(context, currency, to, units)
                        confirming = false
                        amount = ""
                    }) { Text("Abrir el marcador") }
                    TextButton(onClick = { confirming = false }) { Text("Cambiar") }
                }
            }
        }
        if (latest != null) AttemptView(latest, expanded = true)
    }
}

@Composable
private fun StateChip(state: AttemptState) {
    val scheme = MaterialTheme.colorScheme
    val (label, color) = when (state) {
        AttemptState.SENT -> "Enviada · sin verificar" to scheme.onSurfaceVariant
        AttemptState.DIALER -> "En el marcador · sin verificar" to scheme.onSurfaceVariant
        AttemptState.REPLIED -> "Esperando el SMS · sin verificar" to scheme.primary
        AttemptState.FAILED -> "El teléfono no la envió" to Color(0xFFD9806F)
        AttemptState.VERIFIED -> "Verificada por SMS" to River
    }
    val c by animateColorAsState(color, tween(320, easing = Settle), label = "state")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Spacer(Modifier.width(8.dp).height(8.dp).clip(RoundedCornerShape(4.dp)).background(c))
        Spacer(Modifier.width(8.dp))
        Text(label, color = c, fontSize = 13.sp)
    }
}

private val timeFormat = SimpleDateFormat("d MMM HH:mm", Locale("es"))

@Composable
private fun AttemptView(a: Attempt, expanded: Boolean) {
    val scheme = MaterialTheme.colorScheme
    var showCode by remember(a.id) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(timeFormat.format(Date(a.startedAt)), color = scheme.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.width(10.dp))
            StateChip(a.state)
        }
        if (a.op == "45") {
            Text("${a.amount} ${a.currency} → ····${a.to?.takeLast(4)}", fontSize = if (expanded) 22.sp else 16.sp, fontWeight = FontWeight.SemiBold)
            a.transactionId?.let { Text("Transacción $it", color = scheme.onSurfaceVariant, fontSize = 13.sp) }
            a.available?.let { Text("Saldo restante $it", color = scheme.onSurfaceVariant, fontSize = 13.sp) }
            if (expanded && a.state == AttemptState.DIALER) {
                Text("Si el marcador mostró un error («MMI problem», señal), la transferencia no salió: repítela con buena señal. Si dijo que debes autenticarte, abre sesión arriba y repite.", color = scheme.onSurfaceVariant, fontSize = 13.sp)
            }
        } else if (a.available != null) {
            Text(a.available, fontSize = if (expanded) 28.sp else 18.sp, fontWeight = FontWeight.SemiBold)
            Text("Disponible · contable ${a.accounting}", color = scheme.onSurfaceVariant, fontSize = 13.sp)
        }
        if (expanded) {
            a.reply?.let { Text("Respuesta del banco: $it", fontSize = 14.sp) }
            if (a.code.isNotEmpty()) {
                TextButton(onClick = { showCode = !showCode }) { Text(if (showCode) "Ocultar el código" else "Ver el código", fontSize = 13.sp) }
                if (showCode) Text(a.code, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = scheme.primary)
            }
        }
    }
}

@Composable
private fun Diagnostics() {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    var result by remember { mutableStateOf<String?>(null) }
    Panel {
        Text("Diagnóstico", fontWeight = FontWeight.SemiBold)
        Text(
            "Envía *222# (saldo de Cubacel) por el mismo camino que la consulta del banco. " +
                "Si esto también falla, el problema es el teléfono y no el código del banco.",
            color = scheme.onSurfaceVariant, fontSize = 13.sp,
        )
        TextButton(onClick = {
            result = "Enviando…"
            val start = System.currentTimeMillis()
            val defaultSub = SubscriptionManager.getDefaultVoiceSubscriptionId() == Store.subId
            Ussd.send(
                context, Store.subId, "*222#",
                onReply = {
                    result = "Respondió: $it"
                    Telemetry.event("diag", "op" to "222", "ok" to true, "length" to it.length, "latency_ms" to System.currentTimeMillis() - start, "default_sub" to defaultSub, "text" to it)
                },
                onFailure = { code, error ->
                    result = "Falló con el código $code" + (error?.let { " ($it)" } ?: "")
                    Telemetry.event("diag", "op" to "222", "ok" to false, "failure_code" to code, "error" to error, "default_sub" to defaultSub)
                },
            )
        }) { Text("Probar *222#") }
        result?.let { Text(it, fontSize = 14.sp) }
    }
}

@Composable
private fun Login() {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    var status by remember { mutableStateOf<String?>(null) }
    Panel {
        Text("Abrir sesión en el banco", fontWeight = FontWeight.SemiBold)
        Text(
            "El banco pide autenticarse antes de consultar. Ajé envía tu clave de 4 dígitos en el código y no la guarda.",
            color = scheme.onSurfaceVariant, fontSize = 13.sp,
        )
        Store.authenticatedAt?.let {
            Text("Última sesión confirmada por SMS: ${timeFormat.format(Date(it))}", color = River, fontSize = 13.sp)
        }
        PinField { pin -> Ops.login(context, pin) { status = it } }
        status?.let { Text(it, fontSize = 14.sp) }
    }
}

@Composable
private fun TelemetryHistory() {
    val scheme = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { open = !open }) {
            Text("Lo que Ajé ha enviado (${Telemetry.history.size})", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(if (open) "Ocultar" else "Ver", color = scheme.primary, fontSize = 13.sp)
        }
        if (open) {
            if (Telemetry.history.isEmpty()) Text("Nada todavía.", color = scheme.onSurfaceVariant, fontSize = 13.sp)
            Telemetry.history.forEach { e ->
                Text(
                    if (e.sent) "Enviado" else "Pendiente, se envía al haber red",
                    color = if (e.sent) River else scheme.primary, fontSize = 12.sp,
                )
                Text(e.json, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = scheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun TelemetryPanel() {
    val scheme = MaterialTheme.colorScheme
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Enviar datos de prueba", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Switch(checked = Store.telemetry, onCheckedChange = {
                Store.telemetry = it
                Store.saveSettings()
                if (it) Telemetry.event("telemetry_on")
            })
        }
        Text(
            "Manda la versión de Ajé, de Android y el modelo del teléfono, qué operación corrió, si salió bien, " +
                "cuánto tardó, los errores, y el texto de las respuestas del banco y de sus SMS con cada número " +
                "cambiado por #. Abajo ves exactamente lo que se ha enviado.",
            color = scheme.onSurfaceVariant, fontSize = 13.sp,
        )
    }
}
