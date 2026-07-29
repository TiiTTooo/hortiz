-- ============================================================
-- Gerente: acesso a múltiplas lojas escolhidas pelo dono
-- ============================================================
-- Backfill: gerentes existentes hoje só têm perfis.loja_id, nunca tiveram linha em
-- loja_membros (só owner e comprador tinham). Necessário pra: (1) a Edge Function
-- smart-service autorizar gerente a gerar cobrança da assinatura, (2) o dono poder
-- conceder acesso a lojas extras pra esse gerente.
insert into loja_membros (user_id, loja_id, role)
select id, loja_id, 'manager' from perfis
where role = 'manager' and loja_id is not null
on conflict (user_id, loja_id) do nothing;

-- Dono concede a um gerente que ele já gerencia acesso a mais uma das suas lojas
-- (sem tirar as que ele já tinha — é aditivo).
create or replace function public.conceder_loja_gerente(p_perfil_id uuid, p_loja_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from loja_membros
    where user_id = auth.uid() and role = 'owner' and loja_id = p_loja_id
  ) and not sou_admin() then
    raise exception 'Você não é dono dessa loja';
  end if;

  if not exists (select 1 from perfis where id = p_perfil_id and role = 'manager') then
    raise exception 'Esse perfil não é um gerente';
  end if;

  -- só deixa estender o acesso de um gerente que já é gerente em alguma loja sua —
  -- evita vincular um perfil qualquer sem nenhuma relação com o dono que está chamando
  if not exists (
    select 1 from loja_membros lm
    join loja_membros meu on meu.loja_id = lm.loja_id and meu.user_id = auth.uid() and meu.role = 'owner'
    where lm.user_id = p_perfil_id and lm.role = 'manager'
  ) and not sou_admin() then
    raise exception 'Esse gerente não pertence a nenhuma das suas lojas';
  end if;

  insert into loja_membros (user_id, loja_id, role)
  values (p_perfil_id, p_loja_id, 'manager')
  on conflict (user_id, loja_id) do nothing;
end;
$function$;

-- Dono revoga o acesso de um gerente a UMA loja específica (mantendo as outras).
-- Se a loja removida era a "ativa" no perfil dele, migra pra outra que ele ainda acessa —
-- senão ele ficava com perfis.loja_id apontando pra um lugar que já não é mais dele
-- (e continuaria enxergando os dados de lá até trocar de loja de novo).
create or replace function public.revogar_loja_gerente(p_perfil_id uuid, p_loja_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_total int;
  v_loja_atual bigint;
  v_nova_loja bigint;
begin
  if not exists (
    select 1 from loja_membros
    where user_id = auth.uid() and role = 'owner' and loja_id = p_loja_id
  ) and not sou_admin() then
    raise exception 'Você não é dono dessa loja';
  end if;

  select count(*) into v_total from loja_membros where user_id = p_perfil_id and role = 'manager';
  if v_total <= 1 then
    raise exception 'Essa é a única loja desse gerente — use "Remover acesso" pra tirar o acesso completo dele.';
  end if;

  delete from loja_membros where user_id = p_perfil_id and loja_id = p_loja_id and role = 'manager';

  select loja_id into v_loja_atual from perfis where id = p_perfil_id;
  if v_loja_atual = p_loja_id then
    select loja_id into v_nova_loja from loja_membros where user_id = p_perfil_id and role = 'manager' order by loja_id limit 1;
    update perfis set loja_id = v_nova_loja where id = p_perfil_id;
  end if;
end;
$function$;

-- Dono remove o acesso de um gerente (ou pessoa de "apenas pedidos") por completo:
-- todas as lojas concedidas + o perfil (login) em si. Substitui o delete direto que
-- o app fazia antes em "perfis" — agora limpa loja_membros também, senão ficavam
-- linhas órfãs de acesso concedido que nunca mais eram usadas nem removidas.
create or replace function public.remover_acesso_gerente(p_perfil_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from loja_membros lm
    join perfis p on p.loja_id = lm.loja_id
    where lm.user_id = auth.uid() and lm.role = 'owner' and p.id = p_perfil_id
  ) and not sou_admin() then
    raise exception 'Você não tem permissão pra remover esse acesso';
  end if;

  if not exists (select 1 from perfis where id = p_perfil_id and role in ('manager','pedidos')) then
    raise exception 'Esse perfil não é gerente nem apenas-pedidos';
  end if;

  delete from loja_membros lm
  using loja_membros meu
  where lm.user_id = p_perfil_id
    and lm.role = 'manager'
    and meu.user_id = auth.uid()
    and meu.role = 'owner'
    and meu.loja_id = lm.loja_id;

  delete from perfis where id = p_perfil_id;
end;
$function$;
