const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// ========== CONFIGURAÇÃO INICIAL ==========
dotenv.config();

// ========== UTILS E CLIENTS ==========
const supabase = require('./utils/supabaseClient');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// Logo depois do dotenv.config()
console.log('🔍 Debug Stripe:');
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✅ Configurada' : '❌ NÃO ENCONTRADA');
console.log('STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? '✅ Configurada' : '❌ NÃO ENCONTRADA');

// ========== IMPORTAR ROTAS ==========
const userRoutes = require('./routes/userRoutes');
const debugRoutes = require('./routes/debugRoutes');
const billingRoutes = require('./routes/billingRoutes');
const consultantRoutes = require('./routes/consultantRoutes');
const stripeConnectRoutes = require('./routes/stripeConnect.routes');
const paymentRoutes = require('./routes/payment.routes');
const planosRoutes = require('./routes/planosRoutes');
const produtosRoutes = require('./routes/produtosRoutes');
const stripeCheckoutRoutes = require('./routes/stripeCheckout.routes');
const chatRoutes = require('./routes/chat');

// 🆕 ROTAS DO CLIENTE MOBILE
const clienteAuthRoutes = require('./routes/clienteAuth');
const clienteBuscaRoutes = require('./routes/clienteBusca');
const clienteAtendimentoRoutes = require('./routes/clienteAtendimento');

// 🆕 CRON JOB DE VERIFICAÇÃO DE PAGAMENTOS
const { iniciarVerificacaoDePagamentos } = require('./jobs/checkPayments');
const { iniciarCronExclusoes } = require('./jobs/processarExclusoes');

// ========== TESTE DE CONEXÃO SUPABASE ==========
console.log('✅ Supabase Client inicializado.');

// ========== CONFIGURAÇÃO DO EXPRESS ==========
const app = express();
const server = http.createServer(app);

// ========== MIDDLEWARE DE AUTENTICAÇÃO SUPABASE ==========
const supabaseAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Erro na autenticação:', error);
    return res.status(401).json({ error: 'Erro ao validar token' });
  }
};

// ========== MIDDLEWARE DE LOG ==========
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url}`);
  next();
});

// ========== CORS ==========
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8081',
  'https://plataforma-consultoria-mvp.onrender.com',
  'https://www.suacomprasmart.com.br',
  'http://www.suacomprasmart.com.br'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Origem não permitida pelo CORS'));
    }
  },
  credentials: true
}));

// ⚠️ WEBHOOK DO STRIPE - DEVE VIR ANTES DO express.json() ⚠️
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (request, response) => {
  console.log('🔔 Webhook Stripe recebido...');
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('✅ Webhook verificado:', event.type);
  } catch (err) {
    console.error('❌ Erro de assinatura:', err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'transfer.created':
        await handleTransferCreated(event.data.object);
        break;
      case 'transfer.paid':
        await handleTransferPaid(event.data.object);
        break;
      case 'transfer.failed':
        await handleTransferFailed(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;
      case 'account.updated':
        await handleAccountUpdated(event.data.object);
        break;
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      default:
        console.log(`⚡ Evento não tratado: ${event.type}`);
    }
    response.json({ received: true });
  } catch (error) {
    console.error('💥 Erro ao processar webhook:', error);
    response.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ========== MIDDLEWARE JSON ==========
app.use(express.json());
app.use(cookieParser());

// ========== ROTAS PÚBLICAS ==========
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 API Compra Smart Ativa', 
    status: 'online',
    auth: 'Supabase'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      supabase: supabase ? 'connected' : 'disconnected',
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured'
    }
  });
});

// Rotas públicas
app.use('/api/debug', debugRoutes);
app.use('/api/planos', planosRoutes);
app.use('/api/produtos', produtosRoutes);
app.use('/api/checkout', stripeCheckoutRoutes);
app.use('/api/chat', chatRoutes);

// ROTAS MOBILE PÚBLICAS (Uber Match)
app.use('/api/cliente/auth', clienteAuthRoutes);
app.use('/api/cliente/busca', clienteBuscaRoutes);
app.use('/api/cliente/atendimento', clienteAtendimentoRoutes);

// ========== ROTAS PROTEGIDAS (SUPABASE AUTH) ==========
app.use('/api/users', supabaseAuth, userRoutes);
app.use('/api/billing', supabaseAuth, billingRoutes);
app.use('/api/consultores', supabaseAuth, consultantRoutes);
app.use('/api/stripe-connect', supabaseAuth, stripeConnectRoutes);
app.use('/api/payment', supabaseAuth, paymentRoutes);

// ========== WEBHOOK HANDLERS (LÓGICA DE NEGÓCIO) ==========

async function handlePaymentSucceeded(paymentIntent) {
  console.log('💰 Pagamento bem-sucedido:', paymentIntent.id);
  
  if (paymentIntent.metadata.venda_id) {
    await atualizarStatusVenda(paymentIntent.metadata.venda_id, 'pago', paymentIntent.id);
    
    if (paymentIntent.metadata.consultor_id) {
      await processarComissao(paymentIntent);
    }
  }
}

async function handlePaymentFailed(paymentIntent) {
  console.log('❌ Pagamento falhou:', paymentIntent.id);
  
  if (paymentIntent.metadata.venda_id) {
    await atualizarStatusVenda(paymentIntent.metadata.venda_id, 'cancelado', paymentIntent.id);
  }
}

async function atualizarStatusVenda(vendaId, status, paymentIntentId = null) {
  const updateData = { 
    status, 
    atualizado_em: new Date().toISOString() 
  };
  
  if (paymentIntentId) {
    updateData.stripe_payment_intent_id = paymentIntentId;
  }

  const { error } = await supabase
    .from('vendas')
    .update(updateData)
    .eq('id', vendaId);

  if (error) {
    console.error('❌ Erro ao atualizar venda:', error);
  } else {
    console.log(`✅ Venda ${vendaId} atualizada para ${status}`);
  }
}

async function processarComissao(paymentIntent) {
  const { metadata, id } = paymentIntent;
  
  const { error } = await supabase
    .from('comissoes')
    .insert({
      venda_id: metadata.venda_id,
      consultor_id: metadata.consultor_id,
      valor_comissao: parseInt(metadata.commission_amount) / 100,
      status: 'pendente',
      stripe_payment_intent_id: id,
      criado_em: new Date().toISOString()
    });

  if (error) {
    console.error('❌ Erro ao processar comissão:', error);
  } else {
    console.log('✅ Comissão registrada com sucesso');
  }
}

async function handleTransferCreated(transfer) {
  console.log('📤 Transfer criada:', transfer.id);
}

async function handleTransferPaid(transfer) {
  console.log('✅ Transfer paga:', transfer.id);
}

async function handleTransferFailed(transfer) {
  console.log('❌ Transfer falhou:', transfer.id);
}

async function handleInvoicePaymentFailed(invoice) {
  console.log('⚠️ Pagamento de invoice falhou:', invoice.id);
  
  const customerId = invoice.customer;
  
  const { data: lojista } = await supabase
    .from('lojistas')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .single();

  if (lojista && invoice.attempt_count >= 3) {
    await supabase
      .from('lojistas')
      .update({ 
        status: 'bloqueado', 
        motivo_bloqueio: 'Falta de pagamento (3 tentativas falhadas)' 
      })
      .eq('id', lojista.id);
    
    console.log(`🚫 Lojista ${lojista.id} bloqueado por falta de pagamento`);
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  console.log('💰 Pagamento de invoice bem-sucedido:', invoice.id);
  
  const customerId = invoice.customer;
  
  const { data: lojista } = await supabase
    .from('lojistas')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .single();

  if (lojista) {
    await supabase
      .from('lojistas')
      .update({ 
        status: 'ativo', 
        motivo_bloqueio: null,
        ultimo_pagamento_em: new Date().toISOString() 
      })
      .eq('id', lojista.id);
    
    console.log(`✅ Lojista ${lojista.id} reativado`);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log('🗑️ Assinatura cancelada:', subscription.id);
  
  const { data: lojista } = await supabase
    .from('lojistas')
    .select('*')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (lojista) {
    await supabase
      .from('lojistas')
      .update({ 
        status: 'bloqueado',
        motivo_bloqueio: 'Assinatura cancelada',
        stripe_subscription_id: null 
      })
      .eq('id', lojista.id);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Assinatura atualizada:', subscription.id);
}

async function handleTrialWillEnd(subscription) {
  console.log('⏰ Trial acabando em breve:', subscription.id);
}

async function handleAccountUpdated(account) {
  console.log('🔄 Conta Stripe atualizada:', account.id);
}

async function handleCheckoutCompleted(session) {
  console.log('✅ Checkout concluído:', session.id);
  
  const { metadata, subscription } = session;

  if (metadata.tipo_checkout === 'upgrade_plano') {
    await supabase
      .from('lojistas')
      .update({ 
        plano_id: metadata.plano_id, 
        stripe_subscription_id: subscription 
      })
      .eq('id', metadata.lojista_id);
    
    console.log(`✅ Plano atualizado para lojista ${metadata.lojista_id}`);
  }
}

async function handleSubscriptionCreated(subscription) {
  console.log('🆕 Nova assinatura criada:', subscription.id);
}

// ========== TRATAMENTO DE ERROS ==========
app.use((err, req, res, next) => {
  console.error('❌ Erro detectado:', err.message);
  res.status(500).json({ 
    error: 'Erro interno no servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Rota 404
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Rota não encontrada',
    path: req.path 
  });
});

// ========== INICIALIZAÇÃO DO SERVIDOR ==========
const PORT = process.env.PORT || 10000;

// Iniciar cron jobs
iniciarVerificacaoDePagamentos();
iniciarCronExclusoes();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║    🚀 COMPRA SMART: SERVIDOR ONLINE                   ║
║    Porta: ${PORT.toString().padEnd(42)}║
║    Auth: Supabase ✅                                  ║
║    Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Configurado ✅' : 'Não configurado ❌'}               ║
╚═══════════════════════════════════════════════════════╝
  `);
});

module.exports = app;