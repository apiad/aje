package aje.app

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import aje.core.money.BankCard
import aje.core.money.Currency
import aje.core.money.MobileLine
import aje.core.money.MobilePlan
import aje.core.money.Account
import kotlinx.coroutines.launch

private val Settle = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/** Whether the person turned system animations off; then card changes are instant. */
private fun reduceMotion(context: android.content.Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/** The gold-on-espresso gradient each account face carries, by currency or line. */
private fun brushFor(account: Account): Brush = when (account) {
    is BankCard -> when (account.currency) {
        Currency.CUP -> Brush.linearGradient(listOf(Color(0xFF3A2912), Color(0xFF241708)))
        Currency.CUC -> Brush.linearGradient(listOf(Color(0xFF243528), Color(0xFF132019)))
        Currency.USD -> Brush.linearGradient(listOf(Color(0xFF2E2436), Color(0xFF1B1522)))
    }
    is MobileLine -> Brush.linearGradient(listOf(Color(0xFF352318), Color(0xFF20140B)))
}

private fun kindLabel(account: Account): String = when (account) {
    is BankCard -> "Tarjeta · ${if (account.currency == Currency.USD) "USD / MLC" else account.currency.name}"
    is MobileLine -> "Línea"
}

private fun nameOf(account: Account): String = when (account) {
    is BankCard -> if (account.currency == Currency.USD) "Tarjeta USD / MLC" else "Tarjeta ${account.currency.name}"
    is MobileLine -> account.label
}

/**
 * The account deck. The front card (accounts[frontIndex]) sits on top and is draggable; a swipe
 * left advances to the next account, a swipe right brings the one behind to the front. With system
 * animations off the change is instant. [onFront] reports the new front index.
 */
@Composable
fun Deck(accounts: List<Account>, frontIndex: Int, onFront: (Int) -> Unit, modifier: Modifier = Modifier) {
    if (accounts.isEmpty()) return
    val context = LocalContext.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val widthPx = with(density) { (LocalConfiguration.current.screenWidthDp.dp).toPx() }
    val offsetX = remember { Animatable(0f) }
    val front = frontIndex.coerceIn(0, accounts.lastIndex)

    LaunchedEffect(front) { offsetX.snapTo(0f) }

    Column(modifier) {
        Box(Modifier.fillMaxWidth().height(176.dp)) {
            // Back-to-front: the deeper cards draw first, the front card last and draggable.
            for (depth in 3 downTo 0) {
                val idx = front + depth
                if (idx > accounts.lastIndex) continue
                val account = accounts[idx]
                val dragging = depth == 0
                val dx = if (dragging) offsetX.value else 0f
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(150.dp)
                        .graphicsLayer {
                            translationX = dx
                            translationY = with(density) { (-depth * 11).dp.toPx() }
                            val s = 1f - depth * 0.055f
                            scaleX = s; scaleY = s
                            rotationZ = if (dragging) dx / widthPx * 7f else 0f
                            alpha = if (depth < 3) 1f else 0f
                        }
                        .clip(RoundedCornerShape(20.dp))
                        .background(brushFor(account))
                        .then(
                            if (dragging) Modifier.pointerInput(front, accounts.size) {
                                val tracker = VelocityTracker()
                                detectHorizontalDragGestures(
                                    onDragStart = { tracker.resetTracking() },
                                    onHorizontalDrag = { change, amount ->
                                        tracker.addPosition(change.uptimeMillis, change.position)
                                        scope.launch { offsetX.snapTo(offsetX.value + amount) }
                                    },
                                    onDragEnd = {
                                        val vx = tracker.calculateVelocity().x
                                        val go = kotlin.math.abs(offsetX.value) > widthPx * 0.3f || kotlin.math.abs(vx) > 900f
                                        val next = offsetX.value < 0 || vx < -900f
                                        scope.launch {
                                            if (go && next && front < accounts.lastIndex) {
                                                settle(offsetX, -widthPx, context); offsetX.snapTo(0f); onFront(front + 1)
                                            } else if (go && !next && front > 0) {
                                                settle(offsetX, widthPx, context); offsetX.snapTo(0f); onFront(front - 1)
                                            } else {
                                                settle(offsetX, 0f, context)
                                            }
                                        }
                                    },
                                )
                            } else Modifier,
                        )
                        .padding(16.dp),
                ) { CardFace(account) }
            }
        }
        Spacer(Modifier.height(10.dp))
        DeckControls(accounts, front, onFront)
    }
}

private suspend fun settle(offsetX: Animatable<Float, *>, target: Float, context: android.content.Context) {
    if (reduceMotion(context)) offsetX.snapTo(target)
    else offsetX.animateTo(target, tween(320, easing = Settle))
}

@Composable
private fun CardFace(account: Account) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.SpaceBetween) {
        Text(kindLabel(account), color = Color(0xFFD8C8A8), fontSize = 11.sp, fontWeight = FontWeight.Medium)
        Text(nameOf(account), color = Color(0xFFF1E8D8), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        when (account) {
            is BankCard -> {
                val bal = Store.balanceFor(account.currency)
                Text(bal ?: "—", color = Color(0xFFFFF3DD), fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
                Text(if (bal == null) "toca Ver saldo" else account.currency.name, color = Color(0xFFB49A6F), fontSize = 12.sp)
            }
            is MobileLine -> {
                val bal = Store.mobileBalanceFor(account.subId)
                Text(bal ?: "—", color = Color(0xFFFFF3DD), fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
                val plan = if (account.plan == MobilePlan.POSPAGO) "Pospago" else "Prepago"
                Text(if (bal == null) "toca Saldo móvil" else "$plan · ${account.balanceCode}", color = Color(0xFFB49A6F), fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun DeckControls(accounts: List<Account>, front: Int, onFront: (Int) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { if (front > 0) onFront(front - 1) }, enabled = front > 0) { Text("‹", fontSize = 18.sp) }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            accounts.indices.forEach { i ->
                Box(
                    Modifier.height(7.dp).width(if (i == front) 22.dp else 7.dp).clip(RoundedCornerShape(4.dp))
                        .background(if (i == front) scheme.primary else scheme.outline)
                        .clickable { onFront(i) },
                )
            }
        }
        TextButton(onClick = { if (front < accounts.lastIndex) onFront(front + 1) }, enabled = front < accounts.lastIndex) { Text("›", fontSize = 18.sp) }
    }
}
