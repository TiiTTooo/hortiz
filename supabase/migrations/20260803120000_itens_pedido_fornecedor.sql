-- Cliente pediu pra poder informar o fornecedor já no PEDIDO, não só na hora de
-- registrar a compra (valor + pagamento) — porque em alguns casos o pedido precisa
-- ir pro entregador antes mesmo de saber o valor final/forma de pagamento.
alter table public.itens_pedido add column if not exists fornecedor text;
