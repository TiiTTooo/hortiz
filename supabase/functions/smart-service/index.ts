// ============================================================
// Edge Function: criar-assinatura-asaas (nome real no Supabase: smart-service)
// Duas ações, controladas pelo parâmetro "action":
// - (padrão / "assinar"): cria/reaproveita cliente e assinatura
//   recorrente no Asaas, devolve o link de pagamento.
// - "cancelar": cancela a assinatura recorrente no Asaas.
// Nome da function tem que continuar sendo "smart-service" (URL),
// porque é assim que o app (Hortiz) já chama ela.
//
// NOVO: cada loja tem um campo "cobranca_para" ('loja' | 'dono').
// - 'loja' (padrão): cobra no CNPJ/CPF cadastrado na própria loja (comportamento de sempre).
// - 'dono': cobra no CPF do dono da conta (cadastrado no perfil dele), e reaproveita
//   o MESMO cliente Asaas entre todas as lojas desse dono que também estiverem
//   nesse modo — assim ele recebe tudo sob o próprio CPF, não uma cobrança por loja.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Identifica quem está chamando (via token de login do app)
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: 'Não autenticado. Faça login novamente.' }, 401);
    }
    const userId = userData.user.id;

    // 2) Lê os parâmetros enviados pelo app
    const { loja_id, plano, action } = await req.json();
    if (!loja_id) {
      return jsonResponse({ error: 'Parâmetro loja_id é obrigatório' }, 400);
    }
    if (action !== 'cancelar' && !plano) {
      return jsonResponse({ error: 'Parâmetro plano é obrigatório' }, 400);
    }

    // 3) Só o dono da loja (ou o admin master) pode gerenciar a assinatura dela
    const { data: perfil } = await supabase.from('perfis').select('is_admin').eq('id', userId).single();
    let autorizado = !!perfil?.is_admin;
    if (!autorizado) {
      const { data: membro } = await supabase
        .from('loja_membros')
        .select('role')
        .eq('user_id', userId)
        .eq('loja_id', loja_id)
        .eq('role', 'owner')
        .maybeSingle();
      autorizado = !!membro;
    }
    if (!autorizado) {
      return jsonResponse({ error: 'Você não tem permissão para gerenciar a assinatura dessa loja' }, 403);
    }

    // 4) Lê a chave e o modo (sandbox/produção) configurados no painel Master
    const { data: configRows } = await supabase
      .from('config_sistema')
      .select('chave, valor')
      .in('chave', ['asaas_key', 'asaas_modo']);
    const asaasKey = configRows?.find((c: any) => c.chave === 'asaas_key')?.valor;
    const asaasModo = configRows?.find((c: any) => c.chave === 'asaas_modo')?.valor || 'sandbox';
    if (!asaasKey) {
      return jsonResponse({ error: 'Chave do Asaas não configurada no painel Master' }, 400);
    }
    const baseUrl = (asaasModo === 'production' || asaasModo === 'producao') ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
    const asaasHeaders = { 'Content-Type': 'application/json', 'access_token': asaasKey };

    // 4.1) AÇÃO: CANCELAR ASSINATURA
    if (action === 'cancelar') {
      const { data: subAtual } = await supabase.from('assinaturas').select('*').eq('loja_id', loja_id).single();
      if (!subAtual?.asaas_sub_id) {
        // Não existe assinatura recorrente no Asaas ainda — só marca como cancelada no banco
        await supabase.from('assinaturas').update({ status: 'cancelada', updated_at: new Date().toISOString() }).eq('loja_id', loja_id);
        return jsonResponse({ cancelado: true });
      }
      const delResp = await fetch(`${baseUrl}/subscriptions/${subAtual.asaas_sub_id}`, {
        method: 'DELETE',
        headers: asaasHeaders,
      });
      if (!delResp.ok && delResp.status !== 404) {
        const delData = await delResp.json().catch(() => ({}));
        const msg = delData?.errors?.[0]?.description || delResp.statusText;
        return jsonResponse({ error: 'Erro ao cancelar no Asaas: ' + msg }, 400);
      }
      await supabase
        .from('assinaturas')
        .update({ status: 'cancelada', updated_at: new Date().toISOString() })
        .eq('loja_id', loja_id);
      return jsonResponse({ cancelado: true });
    }

    // 5) Busca a assinatura e os dados da loja no nosso banco
    const { data: sub } = await supabase.from('assinaturas').select('*').eq('loja_id', loja_id).single();
    const { data: loja } = await supabase.from('lojas').select('*').eq('id', loja_id).single();
    if (!loja) {
      return jsonResponse({ error: 'Loja não encontrada' }, 404);
    }

    // 5.05) Limite de velocidade: barra chamadas repetidas em menos de 8 segundos
    //       pra essa mesma loja, evitando clique duplicado/abuso gerando várias
    //       cobranças ou clientes em sequência no Asaas. Usa um campo dedicado
    //       (não o updated_at, que o Master também atualiza no auto-salvamento
    //       de valor — usar o mesmo campo bloquearia toda chamada vinda de lá).
    if (sub?.ultima_tentativa_cobranca) {
      const segundosDesdeUltima = (Date.now() - new Date(sub.ultima_tentativa_cobranca).getTime()) / 1000;
      if (segundosDesdeUltima < 8) {
        return jsonResponse(
          { error: 'Aguarda alguns segundos antes de tentar gerar a cobrança de novo.' },
          429,
        );
      }
    }
    await supabase.from('assinaturas').update({ ultima_tentativa_cobranca: new Date().toISOString() }).eq('loja_id', loja_id);

    // 5.1) Descobre quem é o dono da loja (usado tanto pro modo "dono" quanto como
    //      nome/email padrão do cliente no modo "loja")
    const { data: donoMembro } = await supabase
      .from('loja_membros')
      .select('user_id')
      .eq('loja_id', loja_id)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle();
    const donoUserId = donoMembro?.user_id || null;
    const donoPerfil = donoUserId
      ? (await supabase.from('perfis').select('nome, email, cpf').eq('id', donoUserId).single()).data
      : null;

    // 5.2) Decide se a cobrança vai pro CNPJ/CPF da própria loja, ou pro CPF do dono
    const cobrarDoDono = loja.cobranca_para === 'dono';
    let documentoCliente: string;
    let nomeCliente: string;
    let emailCliente: string | undefined;

    if (cobrarDoDono) {
      if (!donoPerfil?.cpf) {
        return jsonResponse(
          {
            error:
              'Essa loja está configurada pra cobrar do dono da conta, mas o CPF dele ainda não foi cadastrado em Configurações.',
          },
          400,
        );
      }
      documentoCliente = String(donoPerfil.cpf).replace(/\D/g, '');
      nomeCliente = donoPerfil.nome || 'Dono da conta';
      emailCliente = donoPerfil.email;
    } else {
      documentoCliente = loja.cnpj ? String(loja.cnpj).replace(/\D/g, '') : '';
      if (!documentoCliente) {
        return jsonResponse(
          { error: 'Preencha o CNPJ ou CPF da loja em "Minha Loja" antes de assinar — o Asaas exige esse dado pra gerar a cobrança.' },
          400,
        );
      }
      nomeCliente = loja.nome || donoPerfil?.nome || 'Cliente Hortiz';
      emailCliente = donoPerfil?.email;
    }

    const valorMensal = parseFloat(sub?.valor_mensal || 250);
    const valor = plano === 'anual' ? valorMensal * 12 : valorMensal;
    const cycle = plano === 'anual' ? 'YEARLY' : 'MONTHLY';

    // 6) Garante que existe um cliente no Asaas vinculado a essa loja (ou ao dono, no modo "dono")
    let customerId = sub?.asaas_customer_id;

    // 6.1) Modo "dono": antes de criar um cliente novo, procura se alguma OUTRA loja desse
    //      mesmo dono (também no modo "dono") já tem um cliente Asaas — se tiver, reaproveita
    //      o mesmo, pra não gerar um cliente duplicado por escola.
    if (!customerId && cobrarDoDono && donoUserId) {
      const { data: lojasDoMesmoDono } = await supabase
        .from('loja_membros')
        .select('loja_id')
        .eq('user_id', donoUserId)
        .eq('role', 'owner');
      const idsOutrasLojas = (lojasDoMesmoDono || [])
        .map((l: any) => l.loja_id)
        .filter((id: number) => id !== loja_id);

      if (idsOutrasLojas.length) {
        const { data: assinaturasIrmas } = await supabase
          .from('assinaturas')
          .select('asaas_customer_id, lojas!inner(cobranca_para)')
          .in('loja_id', idsOutrasLojas)
          .eq('lojas.cobranca_para', 'dono')
          .not('asaas_customer_id', 'is', null)
          .limit(1);
        if (assinaturasIrmas && assinaturasIrmas.length) {
          customerId = (assinaturasIrmas[0] as any).asaas_customer_id;
          await supabase.from('assinaturas').update({ asaas_customer_id: customerId }).eq('loja_id', loja_id);
        }
      }
    }

    // 6.2) Confere se o cliente salvo ainda existe de verdade no Asaas — pode ter sido
    //      removido manualmente lá (ou ser um resquício de um ambiente antigo). O Asaas
    //      não devolve erro nesse caso, devolve resposta normal com "deleted": true —
    //      por isso confere os dois: status da resposta E esse campo.
    if (customerId) {
      const checkCustResp = await fetch(`${baseUrl}/customers/${customerId}`, { headers: asaasHeaders });
      const checkCustData = await checkCustResp.json().catch(() => null);
      if (!checkCustResp.ok || checkCustData?.deleted) {
        customerId = null;
      }
    }

    if (!customerId) {
      const custBody: Record<string, unknown> = {
        name: nomeCliente,
        email: emailCliente,
        cpfCnpj: documentoCliente,
      };
      if (loja.tel) custBody.mobilePhone = String(loja.tel).replace(/\D/g, '');

      const custResp = await fetch(`${baseUrl}/customers`, {
        method: 'POST',
        headers: asaasHeaders,
        body: JSON.stringify(custBody),
      });
      const custData = await custResp.json();
      if (!custResp.ok) {
        const msg = custData?.errors?.[0]?.description || custResp.statusText;
        return jsonResponse({ error: 'Erro ao criar cliente no Asaas: ' + msg }, 400);
      }
      customerId = custData.id;
      await supabase.from('assinaturas').update({ asaas_customer_id: customerId }).eq('loja_id', loja_id);
    } else {
      // Cliente já existe no Asaas — garante que o CPF/CNPJ está sincronizado
      // (cobre o caso de ele ter sido criado antes desse campo estar preenchido,
      // ou de a loja ter trocado de modo loja/dono depois de já ter cliente)
      try {
        await fetch(`${baseUrl}/customers/${customerId}`, {
          method: 'PUT',
          headers: asaasHeaders,
          body: JSON.stringify({ cpfCnpj: documentoCliente }),
        });
      } catch (_e) {
        // se falhar, segue o fluxo normal — o erro real aparecerá na criação da assinatura, se for o caso
      }
    }

    // 7) Se já existe uma assinatura no Asaas, confere se ela ainda existe de verdade,
    //    sincroniza o valor/ciclo atual (inclusive na cobrança pendente já gerada) e
    //    tenta reaproveitar essa cobrança pendente.
    let pagamento: any = null;
    let subIdValido = sub?.asaas_sub_id || null;
    if (subIdValido) {
      const putResp = await fetch(`${baseUrl}/subscriptions/${subIdValido}`, {
        method: 'PUT',
        headers: asaasHeaders,
        body: JSON.stringify({ value: valor, cycle, updatePendingPayments: true }),
      });
      const putData = await putResp.json().catch(() => null);
      if (!putResp.ok || putData?.deleted) {
        // Assinatura não existe mais no Asaas (removida manualmente, ou resquício de outro
        // ambiente) — esquece essa referência e deixa o código criar uma assinatura nova.
        subIdValido = null;
      } else {
        const pendResp = await fetch(
          `${baseUrl}/payments?subscription=${subIdValido}&status=PENDING&limit=1`,
          { headers: asaasHeaders },
        );
        const pendData = await pendResp.json();
        if (pendResp.ok && pendData?.data?.length) {
          pagamento = pendData.data[0];
        }
      }
    }

    // 8) Se não achou cobrança pendente (ou a assinatura antiga não existia mais), cria uma assinatura nova no Asaas
    if (!pagamento) {
      const amanha = new Date();
      amanha.setDate(amanha.getDate() + 1);
      const nextDueDate = amanha.toISOString().split('T')[0];

      const subBody = {
        customer: customerId,
        billingType: 'UNDEFINED', // deixa o cliente escolher PIX, boleto ou cartão
        value: valor,
        nextDueDate,
        cycle,
        description: `Hortiz — ${loja.nome} — Plano ${plano === 'anual' ? 'Anual' : 'Mensal'}`,
      };
      const subResp = await fetch(`${baseUrl}/subscriptions`, {
        method: 'POST',
        headers: asaasHeaders,
        body: JSON.stringify(subBody),
      });
      const subData = await subResp.json();
      if (!subResp.ok) {
        const msg = subData?.errors?.[0]?.description || subResp.statusText;
        return jsonResponse({ error: 'Erro ao criar assinatura no Asaas: ' + msg }, 400);
      }

      await supabase
        .from('assinaturas')
        .update({ asaas_sub_id: subData.id, plano, valor_mensal: valorMensal })
        .eq('loja_id', loja_id);

      const payResp = await fetch(`${baseUrl}/payments?subscription=${subData.id}&limit=1`, {
        headers: asaasHeaders,
      });
      const payData = await payResp.json();
      pagamento = payData?.data?.[0] || null;
    }

    if (!pagamento) {
      return jsonResponse(
        { error: 'Assinatura criada, mas não consegui obter os dados de pagamento. Tente novamente em instantes.' },
        500,
      );
    }

    // 9) Busca os dados pra mostrar Pix e boleto embutidos no próprio Hortiz (cartão continua
    //    indo pro link da fatura do Asaas — ver explicação sobre PCI-DSS).
    let pix: { qrCodeImage: string | null; copiaECola: string | null; expiracao: string | null } | null = null;
    let pixDebug: string | null = null;
    try {
      const pixResp = await fetch(`${baseUrl}/payments/${pagamento.id}/pixQrCode`, { headers: asaasHeaders });
      const pixData = await pixResp.json().catch(() => null);
      if (pixResp.ok && pixData?.payload) {
        pix = {
          qrCodeImage: pixData.encodedImage ? `data:image/png;base64,${pixData.encodedImage}` : null,
          copiaECola: pixData.payload,
          expiracao: pixData.expirationDate || null,
        };
      } else {
        pixDebug = `status ${pixResp.status}: ${pixData?.errors?.[0]?.description || JSON.stringify(pixData)}`;
      }
    } catch (e: any) {
      pixDebug = 'exceção: ' + (e?.message || String(e));
    }

    let boleto: { url: string | null; linhaDigitavel: string | null } | null = null;
    let boletoDebug: string | null = null;
    if (pagamento.bankSlipUrl) {
      let linhaDigitavel: string | null = null;
      try {
        const lineResp = await fetch(`${baseUrl}/payments/${pagamento.id}/identificationField`, {
          headers: asaasHeaders,
        });
        const lineData = await lineResp.json().catch(() => null);
        if (lineResp.ok) {
          linhaDigitavel = lineData?.identificationField || null;
        } else {
          boletoDebug = `linha digitável — status ${lineResp.status}: ${lineData?.errors?.[0]?.description || JSON.stringify(lineData)}`;
        }
      } catch (e: any) {
        boletoDebug = 'linha digitável — exceção: ' + (e?.message || String(e));
      }
      boleto = { url: pagamento.bankSlipUrl, linhaDigitavel };
    } else {
      boletoDebug = 'a cobrança não trouxe bankSlipUrl (campo do boleto) na resposta do Asaas';
    }

    return jsonResponse({
      link: pagamento.invoiceUrl,
      valor,
      pix,
      boleto,
      // Campo de diagnóstico só aparece pro admin master — não é dado sensível,
      // mas é detalhe técnico que não faz sentido mostrar pro dono comum da loja.
      ...(perfil?.is_admin ? { _debug: { pixDebug, boletoDebug } } : {}),
    });
  } catch (e) {
    return jsonResponse({ error: e?.message || 'Erro inesperado' }, 500);
  }
});
