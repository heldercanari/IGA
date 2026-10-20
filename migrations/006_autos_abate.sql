-- ============================================================
-- 006 — Autos de abate: propor, montar o auto, homologar
--
-- Até aqui abater era um clique, e o equipamento ficava abatido nesse
-- instante. Na PM não é assim: o equipamento é proposto, uma comissão de três
-- verifica-o, lavra-se o auto no modelo da DMSI, e só com o auto homologado é
-- que fica abatido. Entre a proposta e a homologação passam semanas — e nesse
-- tempo o equipamento não pode contar como abatido nem ser entregue a ninguém.
--
-- PORQUÊ — um auto por categoria, e numeração única da PM
-- --------------------------------------------------------
-- **Cada auto é de uma categoria só** (decisão de 2026-10-20): rádios com
-- rádios, telemóveis com telemóveis. A coluna `tipo` diz qual, e as linhas do
-- auto vivem na tabela de abates do próprio tipo — juntar categorias é
-- impossível por construção.
--
-- **A numeração é a da PM, por ano, a mesma para todas as categorias** (o
-- 02/2023 dos rádios é dela). O n.º escreve-se ao criar o auto — é o do papel —
-- e o IGA sugere `MAX(numero) + 1` do ano. Por isso o cabeçalho dos autos vive
-- numa tabela só, aqui na base do módulo, e o `UX_autos_abate_numero` impede dois
-- autos com o mesmo número, seja de que categoria for.
--
-- PORQUÊ — os abates passam a ter estado
-- --------------------------------------
-- Uma linha em `<tipo>_abates` era "abatido". Passa a ter `estado`:
--   'proposto' — marcado para abate, ainda sem auto homologado. O equipamento
--                mantém o estado que tinha (normalmente 'avariado').
--   'abatido'  — o auto foi homologado (ou é um abate antigo, de antes disto).
-- O `recalcularEstado()` de cada tipo só conta os 'abatido'. As linhas que já
-- existem ficam 'abatido' pelo DEFAULT — eram abates feitos, e continuam a sê-lo.
--
-- `auto_id` liga a linha ao auto. Nos telemóveis a ligação não tem FOREIGN KEY:
-- vivem noutra base em desenvolvimento (ver a 007).
--
-- PORQUÊ — impressoras e máquinas fotográficas ganham abates
-- ----------------------------------------------------------
-- Decisão de 2026-10-20: também vão a auto. A 003 e a 004 diziam "sem abates";
-- passam a tê-los, no mesmo molde. Continuam sem coluna `estado` — abatida é
-- ter uma linha 'abatido' aqui, lido onde é preciso, como a entrega aberta das
-- máquinas.
--
-- Idempotente. Alvo: base do `db.js` (`RadiosDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. O cabeçalho dos autos ───────────────────────────────
IF OBJECT_ID('dbo.autos_abate', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.autos_abate (
        id               INT IDENTITY(1,1) NOT NULL,
        tipo             VARCHAR(20)   NOT NULL,   -- radios, telemoveis, impressoras, maquinas, tablets
        ano              INT           NOT NULL,
        numero           INT           NOT NULL,   -- 2 → "02/2023"
        data             DATE          NOT NULL,   -- o "Em" do modelo: dia da reunião da comissão
        comissao1        NVARCHAR(200) NULL,
        comissao2        NVARCHAR(200) NULL,
        comissao3        NVARCHAR(200) NULL,
        destino          NVARCHAR(300) NULL,       -- "abatendo-os à responsabilidade de"
        valor            NVARCHAR(300) NULL,       -- "Valor do auto"
        estado           VARCHAR(20)   NOT NULL CONSTRAINT DF_autos_abate_estado DEFAULT ('rascunho'),
        data_homologacao DATE          NULL,
        obs              NVARCHAR(MAX) NULL,
        registado_por    NVARCHAR(120) NULL,
        criado_em        DATETIME      NOT NULL CONSTRAINT DF_autos_abate_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_autos_abate PRIMARY KEY (id),
        CONSTRAINT CK_autos_abate_tipo CHECK (tipo IN ('radios', 'telemoveis', 'impressoras', 'maquinas', 'tablets')),
        CONSTRAINT CK_autos_abate_estado CHECK (estado IN ('rascunho', 'homologado'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_autos_abate_numero' AND object_id = OBJECT_ID('dbo.autos_abate'))
    CREATE UNIQUE INDEX UX_autos_abate_numero ON dbo.autos_abate(ano, numero);
GO

-- ── 2. Estado, auto e doação nos abates que já existem ─────
-- Um bloco por tabela; cada coluna só entra se ainda não lá estiver.
IF COL_LENGTH('dbo.radios_abates', 'estado') IS NULL
    ALTER TABLE dbo.radios_abates ADD
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_radios_abates_estado DEFAULT ('abatido')
                        CONSTRAINT CK_radios_abates_estado CHECK (estado IN ('proposto', 'abatido')),
        auto_id         INT           NULL CONSTRAINT FK_radios_abates_auto REFERENCES dbo.autos_abate(id),
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL;
GO

IF COL_LENGTH('dbo.tablets_abates', 'estado') IS NULL
    ALTER TABLE dbo.tablets_abates ADD
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_tablets_abates_estado DEFAULT ('abatido')
                        CONSTRAINT CK_tablets_abates_estado CHECK (estado IN ('proposto', 'abatido')),
        auto_id         INT           NULL CONSTRAINT FK_tablets_abates_auto REFERENCES dbo.autos_abate(id),
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL;
GO

-- ── 3. Impressoras e máquinas fotográficas: abates novos ───
IF OBJECT_ID('dbo.impressoras_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.impressoras_abates (
        id              INT IDENTITY(1,1) NOT NULL,
        impressora_id   INT           NOT NULL,
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_impressoras_abates_estado DEFAULT ('proposto'),
        auto_id         INT           NULL,
        data_abate      DATE          NULL,
        motivo          NVARCHAR(200) NULL,
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL,
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_impressoras_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_impressoras_abates PRIMARY KEY (id),
        CONSTRAINT FK_impressoras_abates_imp FOREIGN KEY (impressora_id)
            REFERENCES dbo.impressoras(id) ON DELETE CASCADE,
        CONSTRAINT FK_impressoras_abates_auto FOREIGN KEY (auto_id) REFERENCES dbo.autos_abate(id),
        CONSTRAINT CK_impressoras_abates_estado CHECK (estado IN ('proposto', 'abatido'))
    );
    CREATE UNIQUE INDEX UX_impressoras_abates_imp ON dbo.impressoras_abates(impressora_id);
END
GO

IF OBJECT_ID('dbo.maquinas_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.maquinas_abates (
        id              INT IDENTITY(1,1) NOT NULL,
        maquina_id      INT           NOT NULL,
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_maquinas_abates_estado DEFAULT ('proposto'),
        auto_id         INT           NULL,
        data_abate      DATE          NULL,
        motivo          NVARCHAR(200) NULL,
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL,
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_maquinas_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_maquinas_abates PRIMARY KEY (id),
        CONSTRAINT FK_maquinas_abates_maq FOREIGN KEY (maquina_id)
            REFERENCES dbo.maquinas(id) ON DELETE CASCADE,
        CONSTRAINT FK_maquinas_abates_auto FOREIGN KEY (auto_id) REFERENCES dbo.autos_abate(id),
        CONSTRAINT CK_maquinas_abates_estado CHECK (estado IN ('proposto', 'abatido'))
    );
    CREATE UNIQUE INDEX UX_maquinas_abates_maq ON dbo.maquinas_abates(maquina_id);
END
GO

PRINT '006_autos_abate: OK';
GO
