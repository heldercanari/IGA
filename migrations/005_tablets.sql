-- ============================================================
-- 005 — Tablets: o quinto tipo de activo entra no módulo
--
-- Os tablets estavam em três folhas do `IpsImpressoras e consumiveis.xlsx` (o
-- livro do NSIC no OneDrive): "Tablet Div Pol", "Tablet Div Tran" e "Tablet Seg
-- Priv" — 34 aparelhos Samsung Galaxy Tab. Vão ser distribuídos a pessoas, e
-- as avarias e os abates registam-se: é o molde completo dos telemóveis (002),
-- equipamento + atribuições + avarias + abates, com o mesmo `estado`.
--
-- PORQUÊ — na base dos rádios, sem pool própria
-- ----------------------------------------------
-- Como as impressoras e as máquinas fotográficas: base própria é a excepção
-- que os telemóveis são, não a regra. Corre na base do `db.js`.
--
-- PORQUÊ — sem tabela de importações
-- ----------------------------------
-- Desde 2026-10-13 não há importações (ver o CLAUDE.md). Os 34 tablets das
-- folhas entraram numa carga única, feita directamente na base, e daqui para a
-- frente mantêm-se pelo ecrã. Um `tablets_importacoes` era uma tabela que
-- ninguém escrevia.
--
-- PORQUÊ — o que é cada coluna, vindo das folhas
-- ----------------------------------------------
--   num_inventario  "Nº. INVENTÁRIO" (29/TAB/2023) — só a folha da Div Pol o tem
--   numero          "NÚMERO CARTÃO DE DADOS" — o cartão SIM do tablet
--   iccid           "ICCID" — o número do próprio cartão
--   finalidade      "UTILIZADOR" — ⚠️ nas folhas não é uma pessoa: diz para que
--                   serve o tablet ("Na Minha Rua Lx"). Chamar-lhe utilizador
--                   aqui era confundi-lo com quem o tem, que é a entrega.
--   localizacao     o serviço a que o tablet pertence — veio do nome da folha
--
-- A "ORGÂNICA" das folhas (sempre "PM") e o "TIPO" (sempre "TABLET") não
-- entraram: são o mesmo valor em todas as linhas.
--
-- ⚠️ **O ICCID não é único, e não por descuido do índice.** Na folha da Div Pol
-- dois pares de tablets partilham o ICCID (39 e 44/TAB/2023, 40 e 67/TAB/2023).
-- Um cartão não está em dois aparelhos: é um erro de transcrição, e só se
-- resolve olhando para os cartões. Até lá, um índice único rejeitava dados que
-- estão de facto na origem.
--
-- PORQUÊ — o PIN e o PUK são credenciais, como nos telemóveis
-- ------------------------------------------------------------
-- São do cartão SIM. Ficam fora do que a listagem devolve: só a rota
-- `/tablets/:id/credenciais`, reservada ao grupo `IGA-Admin`, as lê. O PIN
-- guarda-se como está, sem completar zeros à esquerda (ver a 002).
--
-- Os grupos de acesso são os da 001: é o mesmo módulo. Esta migração não lhes toca.
--
-- Idempotente: pode correr as vezes que forem precisas.
-- Alvo: SQL Server, base `RadiosDev` em desenvolvimento (a do `db.js`).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. Os aparelhos ────────────────────────────────────────
IF OBJECT_ID('dbo.tablets', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tablets (
        id              INT IDENTITY(1,1) NOT NULL,
        num_inventario  NVARCHAR(40)  NULL,   -- 29/TAB/2023
        numero          NVARCHAR(20)  NULL,   -- 913988440 (cartão de dados)
        iccid           NVARCHAR(30)  NULL,   -- ⚠️ não é único: ver acima
        imei            NVARCHAR(30)  NULL,
        num_serie       NVARCHAR(40)  NULL,
        marca           NVARCHAR(40)  NULL,
        modelo          NVARCHAR(80)  NULL,
        pin             NVARCHAR(20)  NULL,   -- credencial: só administração
        puk             NVARCHAR(20)  NULL,   -- credencial: só administração
        finalidade      NVARCHAR(120) NULL,   -- "Na Minha Rua Lx" — para que serve, não quem o tem
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_tablets_estado DEFAULT ('disponivel'),
        localizacao     NVARCHAR(120) NULL,   -- serviço a que pertence
        obs             NVARCHAR(MAX) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_tablets_criado_em DEFAULT (GETDATE()),
        atualizado_em   DATETIME      NOT NULL CONSTRAINT DF_tablets_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_tablets PRIMARY KEY (id),
        CONSTRAINT CK_tablets_estado CHECK (estado IN ('disponivel', 'atribuido', 'avariado', 'abatido'))
    );
END
GO

-- Únicos *quando existem*, como o número de série dos rádios: o inventário só
-- vem numa das três folhas, e um tablet pode ficar sem cartão.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_tablets_num_inventario' AND object_id = OBJECT_ID('dbo.tablets'))
    CREATE UNIQUE INDEX UX_tablets_num_inventario ON dbo.tablets(num_inventario) WHERE num_inventario IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_tablets_numero' AND object_id = OBJECT_ID('dbo.tablets'))
    CREATE UNIQUE INDEX UX_tablets_numero ON dbo.tablets(numero) WHERE numero IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_tablets_imei' AND object_id = OBJECT_ID('dbo.tablets'))
    CREATE UNIQUE INDEX UX_tablets_imei ON dbo.tablets(imei) WHERE imei IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_tablets_num_serie' AND object_id = OBJECT_ID('dbo.tablets'))
    CREATE UNIQUE INDEX UX_tablets_num_serie ON dbo.tablets(num_serie) WHERE num_serie IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tablets_estado' AND object_id = OBJECT_ID('dbo.tablets'))
    CREATE INDEX IX_tablets_estado ON dbo.tablets(estado);
GO

-- ── 2. Quem tem o quê ──────────────────────────────────────
IF OBJECT_ID('dbo.tablets_atribuicoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tablets_atribuicoes (
        id              INT IDENTITY(1,1) NOT NULL,
        tablet_id       INT           NOT NULL,
        matricula       INT           NULL,
        nome_utilizador NVARCHAR(200) NULL,
        data_entrega    DATE          NULL,
        data_devolucao  DATE          NULL,   -- NULL = ainda o tem
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_tablets_atrib_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_tablets_atribuicoes PRIMARY KEY (id),
        CONSTRAINT FK_tablets_atribuicoes_tab FOREIGN KEY (tablet_id)
            REFERENCES dbo.tablets(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tablets_atribuicoes_tab' AND object_id = OBJECT_ID('dbo.tablets_atribuicoes'))
    CREATE INDEX IX_tablets_atribuicoes_tab ON dbo.tablets_atribuicoes(tablet_id, data_devolucao);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tablets_atribuicoes_matricula' AND object_id = OBJECT_ID('dbo.tablets_atribuicoes'))
    CREATE INDEX IX_tablets_atribuicoes_matricula ON dbo.tablets_atribuicoes(matricula);
GO

-- ── 3. Avarias ─────────────────────────────────────────────
IF OBJECT_ID('dbo.tablets_avarias', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tablets_avarias (
        id             INT IDENTITY(1,1) NOT NULL,
        tablet_id      INT           NOT NULL,
        descricao      NVARCHAR(200) NULL,
        estado         VARCHAR(20)   NOT NULL CONSTRAINT DF_tablets_avarias_estado DEFAULT ('aberta'),
        data_registo   DATE          NULL,
        data_reparacao DATE          NULL,
        obs            NVARCHAR(MAX) NULL,
        registado_por  NVARCHAR(120) NULL,
        criado_em      DATETIME      NOT NULL CONSTRAINT DF_tablets_avarias_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_tablets_avarias PRIMARY KEY (id),
        CONSTRAINT FK_tablets_avarias_tab FOREIGN KEY (tablet_id)
            REFERENCES dbo.tablets(id) ON DELETE CASCADE,
        CONSTRAINT CK_tablets_avarias_estado CHECK (estado IN ('aberta', 'reparada', 'irreparavel'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tablets_avarias_tab' AND object_id = OBJECT_ID('dbo.tablets_avarias'))
    CREATE INDEX IX_tablets_avarias_tab ON dbo.tablets_avarias(tablet_id, estado);
GO

-- ── 4. Abates ──────────────────────────────────────────────
IF OBJECT_ID('dbo.tablets_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tablets_abates (
        id            INT IDENTITY(1,1) NOT NULL,
        tablet_id     INT           NOT NULL,
        data_abate    DATE          NULL,
        motivo        NVARCHAR(200) NULL,
        obs           NVARCHAR(MAX) NULL,
        registado_por NVARCHAR(120) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_tablets_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_tablets_abates PRIMARY KEY (id),
        CONSTRAINT FK_tablets_abates_tab FOREIGN KEY (tablet_id)
            REFERENCES dbo.tablets(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_tablets_abates_tab' AND object_id = OBJECT_ID('dbo.tablets_abates'))
    CREATE UNIQUE INDEX UX_tablets_abates_tab ON dbo.tablets_abates(tablet_id);
GO

PRINT '005_tablets: OK';
GO
