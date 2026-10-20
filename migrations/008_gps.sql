-- ============================================================
-- 008 — GPS: o sexto tipo de activo, instalado nas viaturas
--
-- Os GPS (Garmin DriveSmart 65 e TomTom GO Discover) são usados nos reboques.
-- Não se entregam a ninguém: estão numa viatura, e o que se quer deles é saber
-- em qual. É o molde das impressoras (003), com a viatura no lugar do serviço —
-- sem `_atribuicoes`, sem `_avarias` e sem coluna `estado` — e com abates, que
-- desde a 006 todo o equipamento vai a auto.
--
-- PORQUÊ — a viatura são três colunas e não uma tabela
-- ----------------------------------------------------
-- A lista de origem identifica o reboque pelo "Nº Chave" (400, 401…), e tem
-- colunas para a marca e a matrícula da viatura, ainda vazias. Guardam-se as três
-- no próprio GPS, como a localização das impressoras: é onde ele ESTÁ, não por
-- onde andou. Uma tabela de viaturas só se justificava se o IGA viesse a gerir as
-- viaturas — e não é para isso que existe.
--
-- PORQUÊ — "Nº Chave" é texto
-- ---------------------------
-- Hoje são números (400 a 412), mas é a etiqueta da chave do reboque, não uma
-- quantidade: guarda-se como está escrita. A listagem ordena-a como número quando
-- o é.
--
-- Carga: os 20 GPS da lista de 2026-10-20 entraram por SQL fora do repositório,
-- como os tablets — não há importações (ver o CLAUDE.md).
--
-- Idempotente. Alvo: base do `db.js` (`RadiosDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. Os GPS ──────────────────────────────────────────────
IF OBJECT_ID('dbo.gps', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.gps (
        id                INT IDENTITY(1,1) NOT NULL,
        marca             NVARCHAR(40)  NULL,   -- Garmin, TomTom
        modelo            NVARCHAR(80)  NULL,   -- DRIVESMART 65, GO Discover
        num_serie         NVARCHAR(40)  NULL,
        viatura_chave     NVARCHAR(20)  NULL,   -- "Nº Chave" do reboque: 400, 401…
        viatura_marca     NVARCHAR(60)  NULL,
        viatura_matricula NVARCHAR(20)  NULL,
        obs               NVARCHAR(MAX) NULL,
        criado_em         DATETIME      NOT NULL CONSTRAINT DF_gps_criado_em DEFAULT (GETDATE()),
        atualizado_em     DATETIME      NOT NULL CONSTRAINT DF_gps_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_gps PRIMARY KEY (id)
    );
END
GO

-- A série é única quando existe: um dos Garmin (chave 404) veio sem ela.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_gps_num_serie' AND object_id = OBJECT_ID('dbo.gps'))
    CREATE UNIQUE INDEX UX_gps_num_serie ON dbo.gps(num_serie) WHERE num_serie IS NOT NULL;
GO

-- ── 2. Abates, no molde da 006 ─────────────────────────────
IF OBJECT_ID('dbo.gps_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.gps_abates (
        id              INT IDENTITY(1,1) NOT NULL,
        gps_id          INT           NOT NULL,
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_gps_abates_estado DEFAULT ('proposto'),
        auto_id         INT           NULL,
        data_abate      DATE          NULL,
        motivo          NVARCHAR(200) NULL,
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL,
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_gps_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_gps_abates PRIMARY KEY (id),
        CONSTRAINT FK_gps_abates_gps FOREIGN KEY (gps_id) REFERENCES dbo.gps(id) ON DELETE CASCADE,
        CONSTRAINT FK_gps_abates_auto FOREIGN KEY (auto_id) REFERENCES dbo.autos_abate(id),
        CONSTRAINT CK_gps_abates_estado CHECK (estado IN ('proposto', 'abatido'))
    );
    CREATE UNIQUE INDEX UX_gps_abates_gps ON dbo.gps_abates(gps_id);
END
GO

-- ── 3. Os autos de abate passam a aceitar GPS ──────────────
-- O CHECK da 006 lista os tipos à mão: um tipo novo tem de entrar nele.
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = 'CK_autos_abate_tipo' AND definition LIKE '%gps%')
BEGIN
    ALTER TABLE dbo.autos_abate DROP CONSTRAINT CK_autos_abate_tipo;
    ALTER TABLE dbo.autos_abate ADD CONSTRAINT CK_autos_abate_tipo
        CHECK (tipo IN ('radios', 'telemoveis', 'impressoras', 'maquinas', 'tablets', 'gps'));
END
GO

PRINT '008_gps: OK';
GO
