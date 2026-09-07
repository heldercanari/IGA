-- ============================================================
-- 004 — Máquinas fotográficas: o quarto tipo de activo
--
-- Substitui a folha `Kodak PIXPRO` do `Kodak.xlsx` (C:\Apps\, 27 folhas, o livro
-- geral do NSIC) — 15 Kodak PIXPRO WPZ2 com cartão de memória, quatro delas
-- levantadas por agentes.
--
-- PORQUÊ — `maquinas` e não `maquinas_fotograficas`
-- ---------------------------------------------------
-- Os nomes dos tipos são uma palavra (`radios`, `telemoveis`, `impressoras`) e
-- este mantém-no: `maquinas` nas tabelas, na API (`/api/iga/maquinas`) e na
-- página (`maquinas.html`). O nome por extenso — **Máquina Fotográfica** — vive
-- só nos ecrãs, como acontece com o próprio IGA. Se um dia entrar outra família
-- de máquinas, é uma renomeação de quatro sítios, não uma dívida.
--
-- PORQUÊ — tem atribuições, ao contrário das impressoras
-- --------------------------------------------------------
-- A `003` explica que uma impressora não é entregue a ninguém. Uma máquina
-- fotográfica é: a folha traz a coluna "Levantou", com quem a tem e a matrícula.
-- Por isso este tipo **volta ao molde** dos rádios e dos telemóveis, com a sua
-- `maquinas_atribuicoes` — uma linha por levantamento, a que está aberta é a que
-- tem `data_devolucao` a NULL.
--
-- PORQUÊ — sem `_avarias`, `_abates` nem coluna `estado`
-- --------------------------------------------------------
-- A folha não traz avarias nem abates, e não foram pedidos. Pela mesma razão da
-- `003`: tabelas que ninguém escreve e botões desligados no ecrã não são
-- simetria, são peso morto. **E sem elas não há coluna `estado`**: sobrava um
-- par disponível/atribuído que se lê da própria `maquinas_atribuicoes` — a
-- entrega aberta OU não existe. Guardá-lo numa coluna era arranjar uma segunda
-- fonte de verdade para o que já se sabe, com o desalinhamento a acompanhar.
--
-- Isto **não contradiz** a regra dos rádios e dos telemóveis ("o estado é uma
-- coluna, não uma consulta"): lá a coluna existe porque o estado tem quatro
-- valores com precedência entre si (abatido > avariado > atribuído > disponível)
-- e três tabelas a alimentá-la. Aqui é uma pergunta a uma tabela só. Se um dia
-- as máquinas ganharem avarias, é ficheiro novo, e aí a coluna e o
-- `recalcularEstado()` entram juntos.
--
-- PORQUÊ — base do módulo, sem pool própria
-- -------------------------------------------
-- Como as impressoras: a base apontada pelo `DB_DATABASE` (em desenvolvimento a
-- `RadiosDev`), com a pool do `db.js`. Base própria é a excepção que os
-- telemóveis são. Como no resto do módulo, este SQL nunca qualifica a base.
--
-- ⚠️ O QUE A FOLHA TRAZ E FICA COMO ESTÁ
-- ----------------------------------------
-- - **A "Marca" é "Kodak W" ou "Kodak R"**, não "Kodak". O W e o R distinguem
--   alguma coisa nas máquinas — cor do corpo, série, lote — que a folha não
--   explica. Guarda-se o que lá está: partir "Kodak W" em marca "Kodak" mais um
--   atributo "W" era inventar o significado de uma letra.
--
-- A CAPACIDADE GUARDA-SE COMO "32 GB"
-- ------------------------------------
-- Na folha vem escrita de três maneiras — "32Gb", "32GB" e "32 Gb" — e a base
-- guarda uma: número, espaço, unidade, com o **B maiúsculo**. `B` é *byte* e `b`
-- é *bit*: um cartão de "32 Gb" à letra tinha 4 GB, e não é isso que ninguém
-- quis escrever. O espaço é o que separa uma grandeza da sua unidade.
--
-- Arruma-se **a unidade, nunca o número** — nem a vírgula decimal, que em
-- português é a separadora certa. E só se mexe no que se reconhece: um valor que
-- não seja um número seguido de KB/MB/GB/TB passa intacto. É a
-- `normalizarCapacidade()`, em duas cópias — no router (o que entra pelo ecrã) e
-- no importador (o que vem da folha) —, como o `normalizarIP()` da 003.
-- - **Só um dos quatro levantamentos tem data.** Os outros três entram com
--   `data_entrega` a NULL, que é o que se sabe. Não se inventa uma data padrão:
--   ao contrário do `atribuidos.xlsx` dos rádios, aqui nem sequer há um dia de
--   levantamento comum a que se possa chamar a data do apuramento.
-- - **A coluna "Levantou" traz o *username*, não o nome** (`claudino.antunes`),
--   com a matrícula ao lado. Fica em `nome_utilizador` como está; o ecrã tem o
--   autocompletar do `/radios/utilizadores` para quem quiser escrever o nome a
--   sério por cima.
--
-- Os grupos de acesso são os mesmos da 001 — `IGA`, `IGA-Consulta` e
-- `IGA-Admin`: é o mesmo módulo, não uma aplicação nova.
--
-- Idempotente: pode correr as vezes que forem precisas.
-- Alvo: SQL Server, base do `DB_DATABASE` (`RadiosDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. As máquinas ─────────────────────────────────────────
IF OBJECT_ID('dbo.maquinas', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.maquinas (
        id                INT IDENTITY(1,1) NOT NULL,
        pm_id             NVARCHAR(20)  NULL,   -- '01 PM' … '15 PM' (a chapa da PM)
        marca             NVARCHAR(40)  NULL,   -- ⚠️ 'Kodak W' / 'Kodak R', como vem
        modelo            NVARCHAR(80)  NULL,   -- 'PIXPRO WPZ2'
        num_serie         NVARCHAR(40)  NULL,   -- 'M061640752'
        cartao_marca      NVARCHAR(40)  NULL,   -- Lexar / Sandisk
        cartao_capacidade NVARCHAR(20)  NULL,   -- '32 GB' — forma única, ver acima
        obs               NVARCHAR(MAX) NULL,
        criado_em         DATETIME      NOT NULL CONSTRAINT DF_maquinas_criado_em DEFAULT (GETDATE()),
        atualizado_em     DATETIME      NOT NULL CONSTRAINT DF_maquinas_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_maquinas PRIMARY KEY (id)
    );
END
GO

-- Os dois identificadores da máquina, únicos *quando existem* — o mesmo índice
-- filtrado do `num_serie` dos rádios e das impressoras. O `pm_id` é o que está
-- colado na máquina e o que a listagem mostra primeiro; a série é o que o
-- fornecedor conhece. Uma máquina pode entrar pelo ecrã sem um deles à mão.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_maquinas_pm_id' AND object_id = OBJECT_ID('dbo.maquinas'))
    CREATE UNIQUE INDEX UX_maquinas_pm_id ON dbo.maquinas(pm_id) WHERE pm_id IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_maquinas_num_serie' AND object_id = OBJECT_ID('dbo.maquinas'))
    CREATE UNIQUE INDEX UX_maquinas_num_serie ON dbo.maquinas(num_serie) WHERE num_serie IS NOT NULL;
GO

-- ── 2. Quem levantou o quê ─────────────────────────────────
-- No molde do `telemoveis_atribuicoes` da 002, coluna a coluna: é a mesma ideia
-- (uma linha por entrega, a aberta é a que não tem devolução) e não há razão
-- para a escrever de outra maneira.
IF OBJECT_ID('dbo.maquinas_atribuicoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.maquinas_atribuicoes (
        id              INT IDENTITY(1,1) NOT NULL,
        maquina_id      INT           NOT NULL,
        matricula       INT           NULL,
        nome_utilizador NVARCHAR(200) NULL,   -- ⚠️ da folha vem o username, não o nome
        data_entrega    DATE          NULL,   -- NULL = levantou, não se sabe quando
        data_devolucao  DATE          NULL,   -- NULL = ainda a tem
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_maquinas_atrib_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_maquinas_atribuicoes PRIMARY KEY (id),
        CONSTRAINT FK_maquinas_atribuicoes_maq FOREIGN KEY (maquina_id)
            REFERENCES dbo.maquinas(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_maquinas_atribuicoes_maq' AND object_id = OBJECT_ID('dbo.maquinas_atribuicoes'))
    CREATE INDEX IX_maquinas_atribuicoes_maq ON dbo.maquinas_atribuicoes(maquina_id, data_devolucao);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_maquinas_atribuicoes_matricula' AND object_id = OBJECT_ID('dbo.maquinas_atribuicoes'))
    CREATE INDEX IX_maquinas_atribuicoes_matricula ON dbo.maquinas_atribuicoes(matricula);
GO

-- ── 3. Registo das importações ─────────────────────────────
IF OBJECT_ID('dbo.maquinas_importacoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.maquinas_importacoes (
        id            INT IDENTITY(1,1) NOT NULL,
        ficheiro      NVARCHAR(400) NULL,
        folha         NVARCHAR(120) NULL,   -- o `Kodak.xlsx` tem 27; interessa uma
        resumo        NVARCHAR(MAX) NULL,   -- JSON: linhas lidas, criadas, entregas
        executado_por NVARCHAR(120) NULL,
        executado_em  DATETIME      NOT NULL CONSTRAINT DF_maquinas_importacoes_em DEFAULT (GETDATE()),
        CONSTRAINT PK_maquinas_importacoes PRIMARY KEY (id)
    );
END
GO

PRINT '004_maquinas: OK';
GO
