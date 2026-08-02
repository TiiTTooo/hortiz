-- Tema (claro/escuro) e cor de destaque eram só localStorage, escopado por usuário
-- mas preso ao NAVEGADOR — trocar de navegador/aparelho perdia a preferência mesmo
-- logando na mesma conta. Agora vira preferência de verdade da conta, sincronizada
-- via banco (perfis), com localStorage só como cache local rápido/fallback offline.
alter table public.perfis add column if not exists tema text;
alter table public.perfis add column if not exists cor_destaque text;
