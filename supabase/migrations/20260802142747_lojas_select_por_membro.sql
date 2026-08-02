-- Bug real (não é dono errado — Toninho é dono legítimo das 3 lojas, cada uma com seu
-- próprio gerente): a política de SELECT em "lojas" só liberava ler a loja ATIVA no
-- momento (minha_loja_id()) ou uma loja "recém-criada" (sem ninguém com ela como ativa
-- ainda). Isso quebra o troca-de-loja pra qualquer dono/gerente com mais de uma loja
-- assim que QUALQUER pessoa (o próprio dono, um gerente, etc.) tiver aquela outra loja
-- como ativa — o que é o caso normal assim que a loja é usada. A linha em loja_membros
-- continuava visível, mas o join aninhado pra lojas(*) voltava nulo e a loja sumia da
-- lista, sem erro nenhum. Isso afeta tanto dono multi-loja quanto o gerente multi-loja
-- (recurso adicionado hoje) igualmente.
drop policy if exists "Usuário vê lojas onde é membro" on public.lojas;
create policy "Usuário vê lojas onde é membro" on public.lojas
for select
using (exists (
  select 1 from loja_membros
  where loja_membros.user_id = auth.uid() and loja_membros.loja_id = lojas.id
));
