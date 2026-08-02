-- App ganhou 3 novos tipos de compra além de caixa/unidade (saco, maço, pacote),
-- mas o CHECK em produtos.tipo só aceitava 'caixa'/'unidade' — qualquer INSERT/UPDATE
-- com os novos tipos seria rejeitado pelo banco (erro 23514).
alter table public.produtos drop constraint produtos_tipo_check;
alter table public.produtos add constraint produtos_tipo_check
  check (tipo = any (array['caixa'::text,'saco'::text,'maco'::text,'pacote'::text,'unidade'::text]));
