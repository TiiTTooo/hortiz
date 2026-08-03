-- Mesmo padrão de bug (4ª tabela encontrada): select_categorias já enxerga
-- categorias de qualquer loja vinculada via loja_membros, mas insert/update/delete
-- só existiam escopados a loja_id = minha_loja_id() (loja "ativa" do perfil).
-- Dono/gerente numa loja secundária conseguia VER as categorias de lá mas não
-- criar/editar/excluir — mesmo tipo de bloqueio silencioso já corrigido em
-- compras, lojas e itens_pedido nesta sessão. Comprador não mexe em categorias
-- (isso é gestão de catálogo, feita em "Gerenciar Produtos"), então as novas
-- policies cobrem só owner/manager, como em itens_pedido.
drop policy if exists "Dono/gerente cria categorias nas lojas vinculadas" on public.categorias;
create policy "Dono/gerente cria categorias nas lojas vinculadas" on public.categorias
for insert
with check (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role in ('owner','manager') and loja_membros.loja_id = categorias.loja_id
));

drop policy if exists "Dono/gerente edita categorias nas lojas vinculadas" on public.categorias;
create policy "Dono/gerente edita categorias nas lojas vinculadas" on public.categorias
for update
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role in ('owner','manager') and loja_membros.loja_id = categorias.loja_id
));

drop policy if exists "Dono/gerente remove categorias nas lojas vinculadas" on public.categorias;
create policy "Dono/gerente remove categorias nas lojas vinculadas" on public.categorias
for delete
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.role in ('owner','manager') and loja_membros.loja_id = categorias.loja_id
));
