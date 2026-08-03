-- Mesmo padrão de bug já corrigido em compras (30/31-07) e lojas (02-08):
-- itens_pedido tinha SELECT/UPDATE cobrindo multi-loja (via loja_membros),
-- mas INSERT/DELETE só existiam escopados a loja_id = minha_loja_id() (a loja
-- "ativa" do perfil). Um dono ou gerente que troca pra uma loja secundária
-- (vinculada via loja_membros mas que não é a loja_id ativa em perfis) tinha
-- o INSERT de pedido silenciosamente bloqueado pelo RLS: o item nunca era
-- salvo no banco, então nunca aparecia em Compras; ao tentar de novo, o novo
-- insert também falhava, dando a impressão de "duplicar" só localmente no
-- navegador. Adiciona policies de INSERT/DELETE equivalentes às de
-- SELECT/UPDATE, cobrindo owner e manager via loja_membros.
drop policy if exists "Dono cria pedidos em todas as suas lojas" on public.itens_pedido;
create policy "Dono cria pedidos em todas as suas lojas" on public.itens_pedido
for insert
with check (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'owner'::text and loja_membros.loja_id = itens_pedido.loja_id
));

drop policy if exists "Gerente cria pedidos nas lojas vinculadas" on public.itens_pedido;
create policy "Gerente cria pedidos nas lojas vinculadas" on public.itens_pedido
for insert
with check (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'manager'::text and loja_membros.loja_id = itens_pedido.loja_id
));

drop policy if exists "Dono remove pedidos de todas as suas lojas" on public.itens_pedido;
create policy "Dono remove pedidos de todas as suas lojas" on public.itens_pedido
for delete
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'owner'::text and loja_membros.loja_id = itens_pedido.loja_id
));

drop policy if exists "Gerente remove pedidos das lojas vinculadas" on public.itens_pedido;
create policy "Gerente remove pedidos das lojas vinculadas" on public.itens_pedido
for delete
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'manager'::text and loja_membros.loja_id = itens_pedido.loja_id
));
