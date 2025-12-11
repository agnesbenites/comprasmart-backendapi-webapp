// api-backend/routes/stripeRoutes.js

const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ============================================
// 1. BUSCAR DADOS DE PAGAMENTO DO LOJISTA
// ============================================
router.get('/lojista/:lojistaId/dados-pagamento', async (req, res) => {
    try {
        const { lojistaId } = req.params;

        // 1. Buscar lojista com plano
        const { data: lojista, error: lojistaError } = await supabase
            .from('lojistas')
            .select('*, plano:planos(*)')
            .eq('id', lojistaId)
            .single();

        if (lojistaError || !lojista) {
            return res.status(404).json({ error: 'Lojista nao encontrado' });
        }

        // 2. Se tem customer_id, buscar faturas do Stripe
        let faturas = [];
        if (lojista.stripe_customer_id) {
            try {
                const invoices = await stripe.invoices.list({
                    customer: lojista.stripe_customer_id,
                    limit: 10,
                });

                faturas = invoices.data.map(invoice => ({
                    id: invoice.id,
                    number: invoice.number || invoice.id,
                    date: new Date(invoice.created * 1000).toISOString(),
                    amount: invoice.amount_paid / 100,
                    status: invoice.status === 'paid' ? 'paid' : invoice.status,
                    invoice_pdf: invoice.invoice_pdf,
                    hosted_invoice_url: invoice.hosted_invoice_url,
                }));
            } catch (stripeError) {
                console.error('Erro ao buscar faturas do Stripe:', stripeError);
            }
        }

        // 3. Retornar dados
        res.json({
            success: true,
            user: {
                id: lojista.id,
                email: lojista.email,
                nome: lojista.nome,
                stripe_customer_id: lojista.stripe_customer_id,
                stripe_account_id: lojista.stripe_account_id || null
            },
            planoAtual: lojista.plano ? {
                nome: lojista.plano.nome,
                valor: lojista.plano.preco_mensal,
                status: 'active'
            } : null,
            faturas: faturas
        });

    } catch (error) {
        console.error('Erro ao buscar dados de pagamento:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 2. BUSCAR FATURAS DO CLIENTE
// ============================================
router.get('/faturas/:customerId', async (req, res) => {
    try {
        const { customerId } = req.params;

        const invoices = await stripe.invoices.list({
            customer: customerId,
            limit: 10,
        });

        const formattedInvoices = invoices.data.map(invoice => ({
            id: invoice.id,
            number: invoice.number || invoice.id,
            date: new Date(invoice.created * 1000).toISOString(),
            amount: invoice.amount_paid / 100,
            status: invoice.status,
            invoice_pdf: invoice.invoice_pdf,
            hosted_invoice_url: invoice.hosted_invoice_url,
            period_start: new Date(invoice.period_start * 1000).toISOString().split('T')[0],
            period_end: new Date(invoice.period_end * 1000).toISOString().split('T')[0],
        }));

        res.json({
            success: true,
            faturas: formattedInvoices
        });

    } catch (error) {
        console.error('Erro ao buscar faturas:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 3. DOWNLOAD DE FATURA ESPECIFICA
// ============================================
router.get('/faturas/:invoiceId/download', async (req, res) => {
    try {
        const { invoiceId } = req.params;

        const invoice = await stripe.invoices.retrieve(invoiceId);

        res.json({
            success: true,
            invoice_pdf: invoice.invoice_pdf,
            hosted_invoice_url: invoice.hosted_invoice_url
        });

    } catch (error) {
        console.error('Erro ao buscar fatura:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 4. CRIAR CUSTOMER NO STRIPE
// ============================================
router.post('/criar-customer', async (req, res) => {
    try {
        const { email, nome, lojistaId } = req.body;

        const customer = await stripe.customers.create({
            email: email,
            name: nome,
            metadata: {
                lojista_id: lojistaId
            }
        });

        // Salvar no Supabase
        const { error: updateError } = await supabase
            .from('lojistas')
            .update({ stripe_customer_id: customer.id })
            .eq('id', lojistaId);

        if (updateError) throw updateError;

        res.json({
            success: true,
            customerId: customer.id
        });

    } catch (error) {
        console.error('Erro ao criar customer:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 5. CRIAR ASSINATURA (PLANO)
// ============================================
router.post('/criar-assinatura', async (req, res) => {
    try {
        const { customerId, priceId, usuarioId, tipo } = req.body;

        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            expand: ['latest_invoice.payment_intent'],
            metadata: {
                usuario_id: usuarioId,
                tipo: tipo // 'lojista' ou 'consultor'
            }
        });

        // Salvar no Supabase
        const tabela = tipo === 'lojista' ? 'lojistas' : 'consultores';
        const { error: updateError } = await supabase
            .from(tabela)
            .update({
                stripe_subscription_id: subscription.id,
                plano_ativo: true
            })
            .eq('id', usuarioId);

        if (updateError) throw updateError;

        res.json({
            success: true,
            subscriptionId: subscription.id,
            clientSecret: subscription.latest_invoice.payment_intent.client_secret,
            status: subscription.status
        });

    } catch (error) {
        console.error('Erro ao criar assinatura:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 6. BUSCAR ASSINATURA ATUAL
// ============================================
router.get('/assinatura/:subscriptionId', async (req, res) => {
    try {
        const { subscriptionId } = req.params;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const price = await stripe.prices.retrieve(subscription.items.data[0].price.id);

        res.json({
            success: true,
            assinatura: {
                id: subscription.id,
                status: subscription.status,
                current_period_start: new Date(subscription.current_period_start * 1000),
                current_period_end: new Date(subscription.current_period_end * 1000),
                cancel_at_period_end: subscription.cancel_at_period_end,
                preco: {
                    id: price.id,
                    valor: price.unit_amount / 100,
                    intervalo: price.recurring.interval,
                    produto: price.product
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar assinatura:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 7. CANCELAR ASSINATURA
// ============================================
router.post('/cancelar-assinatura', async (req, res) => {
    try {
        const { subscriptionId, lojistaId } = req.body;

        // Cancelar no final do periodo
        const subscription = await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true
        });

        res.json({
            success: true,
            message: 'Assinatura sera cancelada no final do periodo',
            cancel_at: new Date(subscription.current_period_end * 1000)
        });

    } catch (error) {
        console.error('Erro ao cancelar assinatura:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 8. PORTAL DO CLIENTE STRIPE
// ============================================
router.post('/portal-session', async (req, res) => {
    try {
        const { customerId, returnUrl } = req.body;

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl || process.env.FRONTEND_URL + '/lojista/dashboard',
        });

        res.json({
            success: true,
            url: session.url
        });

    } catch (error) {
        console.error('Erro ao criar portal session:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;