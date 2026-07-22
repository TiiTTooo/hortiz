// ============================================================
// Edge Function: asaas-webhook
// Recebe avisos do Asaas quando uma cobrança é paga/vence e
// atualiza o status da assinatura da loja automaticamente.
//
// IMPORTANTE: esta function precisa ficar PÚBLICA (sem exigir
// login do Supabase) porque quem chama ela é o próprio Asaas,
// não o app. A segurança é feita validando o token no cabeçalho
// "asaas-access-token" contra o valor salvo em config_sistema.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Valida o token de segurança enviado pelo Asaas
    const tokenRecebido = req.headers.get('asaas-access-token') || '';
    const { data: tokenRow } = await supabase
      .from('config_sistema')
      .select('valor')
      .eq('chave', 'asaas_webhook_token')
      .single();

    if (!tokenRow || tokenRecebido !== tokenRow.valor) {
      return new Response(JSON.stringify({ error: 'Token inválido' }), { status: 401 });
    }

    const body = await req.json();
    const evento = body.event;
    const payment = body.payment;

    if (!payment) {
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // 2) Encontra a assinatura correspondente a essa cobrança
    let sub = null;
    if (payment.subscription) {
      const { data } = await supabase
        .from('assinaturas')
        .select('*')
        .eq('asaas_sub_id', payment.subscription)
        .maybeSingle();
      sub = data;
    }
    if (!sub && payment.customer) {
      const { data } = await supabase
        .from('assinaturas')
        .select('*')
        .eq('asaas_customer_id', payment.customer)
        .maybeSingle();
      sub = data;
    }
    if (!sub) {
      // Não é necessariamente um erro — pode ser evento de outra cobrança avulsa
      return new Response(JSON.stringify({ received: true, aviso: 'assinatura não encontrada' }), { status: 200 });
    }

    // 3) Atualiza o status da assinatura conforme o evento recebido
    if (evento === 'PAYMENT_CONFIRMED' || evento === 'PAYMENT_RECEIVED') {
      let proximaData = payment.dueDate;

      // Tenta buscar a data real da próxima cobrança direto no Asaas
      try {
        const { data: keyRow } = await supabase.from('config_sistema').select('valor').eq('chave', 'asaas_key').single();
        const { data: modoRow } = await supabase.from('config_sistema').select('valor').eq('chave', 'asaas_modo').single();
        const baseUrl = (modoRow?.valor === 'production' || modoRow?.valor === 'producao') ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
        if (payment.subscription && keyRow?.valor) {
          const r = await fetch(`${baseUrl}/subscriptions/${payment.subscription}`, {
            headers: { 'access_token': keyRow.valor },
          });
          const d = await r.json();
          if (r.ok && d.nextDueDate) proximaData = d.nextDueDate;
        }
      } catch (_e) {
        // se der erro, mantém a data da própria cobrança como aproximação
      }

      const { error: erroAtivar } = await supabase
        .from('assinaturas')
        .update({ status: 'ativa', proxima_cobranca: proximaData, updated_at: new Date().toISOString() })
        .eq('loja_id', sub.loja_id);
      if (erroAtivar) {
        console.error('Erro ao ativar assinatura via webhook:', erroAtivar.message, 'loja_id:', sub.loja_id);
      }
    } else if (evento === 'PAYMENT_OVERDUE') {
      const { error: erroVencer } = await supabase
        .from('assinaturas')
        .update({ status: 'vencida', updated_at: new Date().toISOString() })
        .eq('loja_id', sub.loja_id);
      if (erroVencer) {
        console.error('Erro ao marcar assinatura vencida via webhook:', erroVencer.message, 'loja_id:', sub.loja_id);
      }
    } else if (evento === 'PAYMENT_REFUNDED' || evento === 'PAYMENT_CHARGEBACK_REQUESTED' || evento === 'PAYMENT_CHARGEBACK_DISPUTE') {
      // Pagamento estornado ou contestado depois de já ter sido confirmado —
      // bloqueia o acesso de novo, em vez de deixar "Ativa" indevidamente.
      const { error: erroEstorno } = await supabase
        .from('assinaturas')
        .update({ status: 'vencida', updated_at: new Date().toISOString() })
        .eq('loja_id', sub.loja_id);
      if (erroEstorno) {
        console.error('Erro ao marcar assinatura como vencida após estorno/chargeback:', erroEstorno.message, 'loja_id:', sub.loja_id);
      }
    }

    // 4) Guarda um histórico da cobrança
    const { error: erroHistorico } = await supabase.from('cobranças').insert({
      loja_id: sub.loja_id,
      assinatura_id: sub.id,
      valor: payment.value,
      status: evento,
      vencimento: payment.dueDate,
    });
    if (erroHistorico) {
      // Não falha o webhook por causa disso (o status da assinatura já foi
      // atualizado, que é o que importa de verdade) — mas registra o erro
      // pra dar pra investigar depois, em vez de sumir em silêncio.
      console.error('Erro ao salvar histórico de cobrança:', erroHistorico.message, 'loja_id:', sub.loja_id);
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || 'Erro inesperado' }), { status: 500 });
  }
});
