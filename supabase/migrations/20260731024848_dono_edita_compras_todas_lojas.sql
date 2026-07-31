-- Mesma lacuna que corrigi pro comprador, só que do lado do dono: ele já podia VER e
-- CRIAR compras em todas as lojas vinculadas (loja_membros, role=owner), mas só podia
-- EDITAR compras da loja "ativa" no momento (minha_loja_id()) — as outras lojas ficavam
-- de fora. A tela "Ver consolidado de todas as minhas lojas" (mostrarComprasConsolidado)
-- reaproveita a mesma view/edição do comprador e mistura compras de várias lojas na
-- mesma lista — então editar o valor de uma compra de uma loja que não é a ativa
-- falhava silenciosamente (RLS bloqueia a UPDATE sem gerar erro no client).
drop policy if exists "Dono edita compras de todas as suas lojas" on public.compras;
create policy "Dono edita compras de todas as suas lojas" on public.compras
for update
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'owner'::text and loja_membros.loja_id = compras.loja_id
));

drop policy if exists "Dono remove compras de todas as suas lojas" on public.compras;
create policy "Dono remove compras de todas as suas lojas" on public.compras
for delete
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'owner'::text and loja_membros.loja_id = compras.loja_id
));
