-- ============================================================
-- 009 — Tipos de equipamento criados pelo ecrã, sem programação
--
-- Até aqui um tipo novo (tablets, GPS…) era uma migração, um ficheiro de rotas
-- e uma página, escritos à mão. Decisão de 2026-11-10: a administração passa a
-- poder criar um tipo pelo ecrã (`tipos.html`), escolhendo os campos, e ele
-- fica com o que os outros têm — entregas ou local, avarias, abates e autos.
--
-- ⚠️ **Os seis tipos que já existem não mudam.** Continuam com as suas tabelas,
-- as suas rotas e as suas páginas (ver o CLAUDE.md). Isto serve só os tipos
-- que vierem a seguir.
--
-- PORQUÊ — tabelas partilhadas, e não uma tabela por tipo
-- --------------------------------------------------------
-- Os tipos feitos à mão têm as suas tabelas (`tablets_*`, `gps_*`). Um tipo
-- criado pelo ecrã não pode: criar tabelas em execução pedia à conta da
-- aplicação permissão de DDL, que na intranet não tem nem deve ter. Por isso
-- todos os tipos do ecrã vivem em `equipamentos*`, separados pelo `tipo_id`.
--
-- PORQUÊ — campos base em colunas, o resto em `valores`
-- ------------------------------------------------------
-- A identificação, a marca, o modelo, a série e o local são colunas a sério: é
-- por elas que se procura, é delas que o auto de abate precisa (o modelo da
-- DMSI pede marca e n.º de série), e os índices únicos vivem nelas. Os campos
-- que a administração inventar ficam em `valores`, um objecto JSON por
-- equipamento, lido e escrito só pelo servidor — nenhuma consulta usa funções
-- de JSON, para não depender da versão do SQL Server da intranet.
--
-- PORQUÊ — o CHECK dos tipos sai do `autos_abate`
-- ------------------------------------------------
-- O `CK_autos_abate_tipo` listava os tipos à mão (ver a 008). Com tipos criados
-- pelo ecrã a lista deixa de ser conhecida de antemão; quem garante que o
-- `tipo` de um auto existe passa a ser o servidor, que só cria autos a partir
-- de um router de tipo.
--
-- Idempotente. Alvo: base do `db.js` (`RadiosDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;
-- Os índices filtrados exigem-no, e o `sqlcmd` sem `-I` arranca com ele desligado.
SET QUOTED_IDENTIFIER ON;
GO

-- ── 1. Os tipos ────────────────────────────────────────────
IF OBJECT_ID('dbo.tipos_equipamento', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tipos_equipamento (
        id                   INT IDENTITY(1,1) NOT NULL,
        codigo               VARCHAR(20)   NOT NULL,   -- vai no URL e no `autos_abate.tipo`: "coletes"
        nome                 NVARCHAR(60)  NOT NULL,   -- o do cartão, no plural: "Coletes"
        singular             NVARCHAR(60)  NOT NULL,   -- "Colete"
        descricao            NVARCHAR(120) NULL,       -- a linha pequena do cartão
        icone                VARCHAR(30)   NOT NULL CONSTRAINT DF_tipos_icone DEFAULT ('box'),
        modo                 VARCHAR(10)   NOT NULL,   -- 'pessoas' entrega-se; 'local' está num sítio
        tem_avarias          BIT           NOT NULL CONSTRAINT DF_tipos_avarias DEFAULT (0),
        rotulo_identificacao NVARCHAR(60)  NOT NULL CONSTRAINT DF_tipos_rot_ident DEFAULT (N'Identificação'),
        rotulo_local         NVARCHAR(60)  NOT NULL CONSTRAINT DF_tipos_rot_local DEFAULT (N'Local'),
        usa_marca            BIT           NOT NULL CONSTRAINT DF_tipos_marca DEFAULT (1),
        usa_modelo           BIT           NOT NULL CONSTRAINT DF_tipos_modelo DEFAULT (1),
        usa_serie            BIT           NOT NULL CONSTRAINT DF_tipos_serie DEFAULT (1),
        criado_por           NVARCHAR(120) NULL,
        criado_em            DATETIME      NOT NULL CONSTRAINT DF_tipos_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_tipos_equipamento PRIMARY KEY (id),
        CONSTRAINT UX_tipos_equipamento_codigo UNIQUE (codigo),
        CONSTRAINT CK_tipos_equipamento_modo CHECK (modo IN ('pessoas', 'local'))
    );
END
GO

-- ── 2. Os campos que a administração acrescentou a cada tipo ──
IF OBJECT_ID('dbo.tipos_campos', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tipos_campos (
        id          INT IDENTITY(1,1) NOT NULL,
        tipo_id     INT           NOT NULL,
        codigo      VARCHAR(30)   NOT NULL,   -- a chave dentro de `equipamentos.valores`; não muda
        rotulo      NVARCHAR(60)  NOT NULL,
        tipo_dado   VARCHAR(10)   NOT NULL,
        opcoes      NVARCHAR(MAX) NULL,       -- só nas listas: um array JSON de textos
        obrigatorio BIT           NOT NULL CONSTRAINT DF_tipos_campos_obrig DEFAULT (0),
        unico       BIT           NOT NULL CONSTRAINT DF_tipos_campos_unico DEFAULT (0),
        na_tabela   BIT           NOT NULL CONSTRAINT DF_tipos_campos_tabela DEFAULT (0),
        ordem       INT           NOT NULL CONSTRAINT DF_tipos_campos_ordem DEFAULT (0),
        CONSTRAINT PK_tipos_campos PRIMARY KEY (id),
        CONSTRAINT FK_tipos_campos_tipo FOREIGN KEY (tipo_id)
            REFERENCES dbo.tipos_equipamento(id) ON DELETE CASCADE,
        CONSTRAINT UX_tipos_campos_codigo UNIQUE (tipo_id, codigo),
        CONSTRAINT CK_tipos_campos_dado CHECK (tipo_dado IN ('texto', 'longo', 'numero', 'data', 'lista', 'simnao'))
    );
END
GO

-- ── 3. Os equipamentos ─────────────────────────────────────
-- Sem ON DELETE CASCADE para o tipo, de propósito: um tipo com equipamento não
-- se apaga (o servidor recusa), e a base diz o mesmo.
IF OBJECT_ID('dbo.equipamentos', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.equipamentos (
        id            INT IDENTITY(1,1) NOT NULL,
        tipo_id       INT           NOT NULL,
        identificacao NVARCHAR(80)  NOT NULL,   -- o que dá nome ao equipamento nos ecrãs
        marca         NVARCHAR(60)  NULL,
        modelo        NVARCHAR(80)  NULL,
        num_serie     NVARCHAR(60)  NULL,
        localizacao   NVARCHAR(120) NULL,       -- só nos tipos de modo 'local': onde ESTÁ
        valores       NVARCHAR(MAX) NULL,       -- os campos do tipo, em JSON
        estado        VARCHAR(20)   NOT NULL CONSTRAINT DF_equipamentos_estado DEFAULT ('disponivel'),
        obs           NVARCHAR(MAX) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_equipamentos_criado_em DEFAULT (GETDATE()),
        atualizado_em DATETIME      NOT NULL CONSTRAINT DF_equipamentos_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_equipamentos PRIMARY KEY (id),
        CONSTRAINT FK_equipamentos_tipo FOREIGN KEY (tipo_id) REFERENCES dbo.tipos_equipamento(id),
        CONSTRAINT CK_equipamentos_estado CHECK (estado IN ('disponivel', 'atribuido', 'avariado', 'abatido'))
    );
END
GO

-- A identificação é única dentro do tipo; a série também, mas só quando existe.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_equipamentos_identificacao' AND object_id = OBJECT_ID('dbo.equipamentos'))
    CREATE UNIQUE INDEX UX_equipamentos_identificacao ON dbo.equipamentos(tipo_id, identificacao);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_equipamentos_num_serie' AND object_id = OBJECT_ID('dbo.equipamentos'))
    CREATE UNIQUE INDEX UX_equipamentos_num_serie ON dbo.equipamentos(tipo_id, num_serie) WHERE num_serie IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_equipamentos_estado' AND object_id = OBJECT_ID('dbo.equipamentos'))
    CREATE INDEX IX_equipamentos_estado ON dbo.equipamentos(tipo_id, estado);
GO

-- ── 4. Entregas, avarias e abates — o molde dos tablets (005 e 006) ──
IF OBJECT_ID('dbo.equipamentos_atribuicoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.equipamentos_atribuicoes (
        id              INT IDENTITY(1,1) NOT NULL,
        equipamento_id  INT           NOT NULL,
        matricula       INT           NULL,
        nome_utilizador NVARCHAR(200) NULL,
        data_entrega    DATE          NULL,
        data_devolucao  DATE          NULL,   -- NULL = ainda o tem
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_equip_atrib_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_equipamentos_atribuicoes PRIMARY KEY (id),
        CONSTRAINT FK_equipamentos_atribuicoes_eq FOREIGN KEY (equipamento_id)
            REFERENCES dbo.equipamentos(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_equipamentos_atribuicoes_eq ON dbo.equipamentos_atribuicoes(equipamento_id, data_devolucao);
END
GO

IF OBJECT_ID('dbo.equipamentos_avarias', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.equipamentos_avarias (
        id             INT IDENTITY(1,1) NOT NULL,
        equipamento_id INT           NOT NULL,
        descricao      NVARCHAR(200) NULL,
        estado         VARCHAR(20)   NOT NULL CONSTRAINT DF_equip_avarias_estado DEFAULT ('aberta'),
        data_registo   DATE          NULL,
        data_reparacao DATE          NULL,
        obs            NVARCHAR(MAX) NULL,
        registado_por  NVARCHAR(120) NULL,
        criado_em      DATETIME      NOT NULL CONSTRAINT DF_equip_avarias_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_equipamentos_avarias PRIMARY KEY (id),
        CONSTRAINT FK_equipamentos_avarias_eq FOREIGN KEY (equipamento_id)
            REFERENCES dbo.equipamentos(id) ON DELETE CASCADE,
        CONSTRAINT CK_equipamentos_avarias_estado CHECK (estado IN ('aberta', 'reparada', 'irreparavel'))
    );
    CREATE INDEX IX_equipamentos_avarias_eq ON dbo.equipamentos_avarias(equipamento_id, estado);
END
GO

IF OBJECT_ID('dbo.equipamentos_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.equipamentos_abates (
        id              INT IDENTITY(1,1) NOT NULL,
        equipamento_id  INT           NOT NULL,
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_equip_abates_estado DEFAULT ('proposto'),
        auto_id         INT           NULL,
        data_abate      DATE          NULL,
        motivo          NVARCHAR(200) NULL,
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL,
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_equip_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_equipamentos_abates PRIMARY KEY (id),
        CONSTRAINT FK_equipamentos_abates_eq FOREIGN KEY (equipamento_id)
            REFERENCES dbo.equipamentos(id) ON DELETE CASCADE,
        CONSTRAINT FK_equipamentos_abates_auto FOREIGN KEY (auto_id) REFERENCES dbo.autos_abate(id),
        CONSTRAINT CK_equipamentos_abates_estado CHECK (estado IN ('proposto', 'abatido'))
    );
    CREATE UNIQUE INDEX UX_equipamentos_abates_eq ON dbo.equipamentos_abates(equipamento_id);
END
GO

-- ── 5. Os autos de abate deixam de listar os tipos à mão ───
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_autos_abate_tipo')
    ALTER TABLE dbo.autos_abate DROP CONSTRAINT CK_autos_abate_tipo;
GO

PRINT '009_tipos: OK';
GO
