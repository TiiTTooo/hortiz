-- O comprador cria e vê compras em TODAS as lojas vinculadas (loja_membros), mas só
-- podia EDITAR compras da loja que estivesse "ativa" no momento (minha_loja_id()) —
-- a política de update existente só cobria isso. Como a confirmação consolidada
-- distribui uma compra pra várias lojas de uma vez, na prática ele ficava sem
-- conseguir corrigir preço/qtd/fornecedor depois de disparar pra todas as escolas,
-- exceto na loja que por acaso estivesse ativa. Esta política replica o mesmo padrão
-- já usado pra SELECT/INSERT de comprador, e pro UPDATE de itens_pedido de comprador.
drop policy if exists "Comprador edita compras das lojas vinculadas" on public.compras;
create policy "Comprador edita compras das lojas vinculadas" on public.compras
for update
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role = 'comprador'::text and loja_membros.loja_id = compras.loja_id
));
