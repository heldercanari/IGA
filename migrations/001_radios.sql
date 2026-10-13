-- ============================================================
-- 001 — Gestão de Rádios: o parque de rádios entra na intranet
--
-- Substitui o ficheiro `Radios apanhado.xlsx` (OneDrive, 7 folhas) que era o
-- registo único do parque de rádios da PM. A migração traz as tabelas e cria os
-- grupos de acesso, no mesmo molde da 017 da correspondência.
--
-- PORQUÊ — o número de série não pode ser a chave
-- ------------------------------------------------
-- No ficheiro de origem só 246 dos 339 rádios têm número de série, e a folha
-- dos avariados identifica 61 equipamentos **só pelo indicativo**. Uma chave
-- natural obrigava a inventar séries para o que falta. Fica um `id` sintético;
-- `num_serie` é único *quando existe* (índice filtrado) e o `indicativo` é
-- indexado mas NÃO único — no ficheiro há indicativos repetidos e são reais,
-- não sujidade: o mesmo número foi reatribuído a equipamento novo sem fechar o
-- anterior. Fazer disso uma restrição rejeitava dados verdadeiros na importação.
--
-- PORQUÊ — aqui as datas são DATE (ao contrário da correspondência)
-- -----------------------------------------------------------------
-- Na correspondência as datas ficaram texto porque chegavam em dois formatos
-- incompatíveis no mesmo campo. Aqui não: as 217 datas de entrega vêm do Excel
-- como datas a sério (serial de data, não texto), e as 11 de devolução também.
-- Tipar como DATE não obriga a adivinhar nada e dá ordenação correcta de graça.
-- As respostas do questionário (folha `Quest`) são a excepção conhecida — vêm
-- em texto "17-Oct-25" e é o importador que as converte, com o cru guardado ao
-- lado em `data_resposta_texto` para o que não se conseguir ler ficar à vista.
--
-- PORQUÊ — o estado vive numa coluna e não é calculado
-- ----------------------------------------------------
-- `estado` podia sair de uma consulta (tem atribuição aberta? tem avaria
-- aberta? foi abatido?), mas as três folhas de origem discordam entre si: há
-- rádios na folha dos avariados que continuam entregues a alguém na folha
-- principal. Uma coluna explícita deixa a contradição visível e corrigível pelo
-- ecrã, em vez de a esconder atrás de um CASE que ninguém lê.
--
-- Idempotente: pode correr as vezes que forem precisas.
-- Alvo: SQL Server. Em desenvolvimento, base própria `RadiosDev`; quando isto
-- for para a intranet, o ficheiro é renumerado para o próximo número livre da
-- sequência de lá (a correspondência ficou na 018).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. O parque ────────────────────────────────────────────
IF OBJECT_ID('dbo.radios', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios (
        id            INT IDENTITY(1,1) NOT NULL,
        num_serie     NVARCHAR(60)  NULL,   -- só 2/3 do parque o tem
        indicativo    NVARCHAR(20)  NULL,   -- "304" — o número por que a esquadra o trata
        marca         NVARCHAR(40)  NULL,   -- Sepura | Motorola
        modelo        NVARCHAR(60)  NULL,   -- SC2020 | STP8038/9038 | STP9000 | MXP600 | ...
        alias_tei     NVARCHAR(60)  NULL,   -- "LSB PMG304 LX", como está no sistema TETRA
        radio_id_tei  INT           NULL,   -- 15021xx, o ID de rádio no TETRA
        tie           NVARCHAR(40)  NULL,   -- identificador de equipamento (só nos Motorola)
        estado        VARCHAR(20)   NOT NULL CONSTRAINT DF_radios_estado DEFAULT ('disponivel'),
        obs           NVARCHAR(MAX) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_radios_criado_em DEFAULT (GETDATE()),
        atualizado_em DATETIME      NOT NULL CONSTRAINT DF_radios_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios PRIMARY KEY (id),
        CONSTRAINT CK_radios_estado CHECK (estado IN ('disponivel', 'atribuido', 'avariado', 'abatido'))
    );
END
GO

-- Único *quando existe*: o índice filtrado deixa passar os 93 rádios sem série
-- e continua a impedir que a importação duplique um que já lá esteja.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_radios_num_serie' AND object_id = OBJECT_ID('dbo.radios'))
    CREATE UNIQUE INDEX UX_radios_num_serie ON dbo.radios(num_serie) WHERE num_serie IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_indicativo' AND object_id = OBJECT_ID('dbo.radios'))
    CREATE INDEX IX_radios_indicativo ON dbo.radios(indicativo);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_estado' AND object_id = OBJECT_ID('dbo.radios'))
    CREATE INDEX IX_radios_estado ON dbo.radios(estado);
GO

-- ── 2. Quem tem o quê ──────────────────────────────────────
-- Uma linha por entrega. A atribuição ACTIVA é a que tem `data_devolucao` NULL;
-- o histórico fica todo, que é o que falta ao ficheiro (lá, devolver era apagar
-- o nome da célula).
IF OBJECT_ID('dbo.radios_atribuicoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_atribuicoes (
        id              INT IDENTITY(1,1) NOT NULL,
        radio_id        INT           NOT NULL,
        matricula       INT           NULL,   -- mecanográfico de quem o tem
        nome_utilizador NVARCHAR(200) NULL,   -- como está escrito na origem
        data_entrega    DATE          NULL,
        data_devolucao  DATE          NULL,   -- NULL = ainda o tem
        guia            NVARCHAR(60)  NULL,   -- referência da guia de entrega em papel
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,   -- username SSPI de quem registou
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_radios_atrib_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_atribuicoes PRIMARY KEY (id),
        CONSTRAINT FK_radios_atribuicoes_radio FOREIGN KEY (radio_id)
            REFERENCES dbo.radios(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_atribuicoes_radio' AND object_id = OBJECT_ID('dbo.radios_atribuicoes'))
    CREATE INDEX IX_radios_atribuicoes_radio ON dbo.radios_atribuicoes(radio_id, data_devolucao);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_atribuicoes_matricula' AND object_id = OBJECT_ID('dbo.radios_atribuicoes'))
    CREATE INDEX IX_radios_atribuicoes_matricula ON dbo.radios_atribuicoes(matricula);
GO

-- ── 3. Avarias ─────────────────────────────────────────────
-- `ordem` guarda o símbolo da folha de origem: 'P' = avaria de programação
-- (resolve-se no posto), '*' = avaria física (vai para reparação externa).
-- `localizacao` é o "Obs" da folha — onde está o equipamento avariado.
IF OBJECT_ID('dbo.radios_avarias', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_avarias (
        id             INT IDENTITY(1,1) NOT NULL,
        radio_id       INT           NOT NULL,
        tipo_avaria    NVARCHAR(120) NULL,   -- Prog. | n/liga | Teclado | Ecrã partido | Botões | ...
        ordem          VARCHAR(10)   NULL,   -- 'P' programação | '*' física
        localizacao    NVARCHAR(60)  NULL,   -- Aguarda Reparação | No armazém | No atendimento
        estado         VARCHAR(20)   NOT NULL CONSTRAINT DF_radios_avarias_estado DEFAULT ('aberta'),
        data_registo   DATE          NULL,
        data_reparacao DATE          NULL,
        obs            NVARCHAR(MAX) NULL,
        registado_por  NVARCHAR(120) NULL,
        criado_em      DATETIME      NOT NULL CONSTRAINT DF_radios_avarias_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_avarias PRIMARY KEY (id),
        CONSTRAINT FK_radios_avarias_radio FOREIGN KEY (radio_id)
            REFERENCES dbo.radios(id) ON DELETE CASCADE,
        CONSTRAINT CK_radios_avarias_estado CHECK (estado IN ('aberta', 'reparada', 'irreparavel'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_avarias_radio' AND object_id = OBJECT_ID('dbo.radios_avarias'))
    CREATE INDEX IX_radios_avarias_radio ON dbo.radios_avarias(radio_id, estado);
GO

-- ── 4. Abates ──────────────────────────────────────────────
-- Um rádio abatido não sai do parque: fica com `estado='abatido'` e uma linha
-- aqui. Apagá-lo perdia o histórico de quem o teve e porque foi abatido.
IF OBJECT_ID('dbo.radios_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_abates (
        id            INT IDENTITY(1,1) NOT NULL,
        radio_id      INT           NOT NULL,
        data_abate    DATE          NULL,
        motivo        NVARCHAR(200) NULL,
        obs           NVARCHAR(MAX) NULL,
        registado_por NVARCHAR(120) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_radios_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_abates PRIMARY KEY (id),
        CONSTRAINT FK_radios_abates_radio FOREIGN KEY (radio_id)
            REFERENCES dbo.radios(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_radios_abates_radio' AND object_id = OBJECT_ID('dbo.radios_abates'))
    CREATE UNIQUE INDEX UX_radios_abates_radio ON dbo.radios_abates(radio_id);
GO

-- ── 5. Registo do sistema TETRA (folha `TEI`) ──────────────
-- Exportação da consola do sistema: 715 equipamentos com alias, série e ID de
-- rádio. É a fonte da verdade sobre o que está PROGRAMADO — não sobre quem o
-- tem. Fica em tabela própria, e não misturada com `radios`, porque as duas
-- listas não coincidem: há rádios no sistema que a folha principal não conhece,
-- e vice-versa. O ecrã de conferência vive dessa diferença.
--
-- Das 48 colunas da exportação ficam as que variam. As outras 30 e tal são
-- constantes em todas as linhas ("Yes"/"No"/"EMERGENCIA"/"TEMPLATE") — copiá-las
-- era guardar 715 vezes a mesma palavra.
IF OBJECT_ID('dbo.radios_sistema', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_sistema (
        id                  INT IDENTITY(1,1) NOT NULL,
        alias               NVARCHAR(60)  NULL,   -- "LSB PMG304 LX"
        indicativo          NVARCHAR(20)  NULL,   -- extraído do alias pelo importador, quando dá
        security_group      NVARCHAR(60)  NULL,   -- CML-PM
        num_serie           NVARCHAR(60)  NULL,
        radio_id            INT           NULL,   -- 15021xx (= Direct Dial Number)
        talkgroup           NVARCHAR(60)  NULL,   -- PT PM | PT CMLRSB
        perfil_capacidades  NVARCHAR(60)  NULL,   -- CML AllEnabled | CML NoPrivateCal
        interconnect        NVARCHAR(40)  NULL,   -- Inbound | InboundOutbound
        full_duplex         VARCHAR(5)    NULL,
        escuta_ambiente     VARCHAR(5)    NULL,   -- Ambience Listening Monitoring
        acesso_pstn         VARCHAR(5)    NULL,
        importado_em        DATETIME      NOT NULL CONSTRAINT DF_radios_sistema_importado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_sistema PRIMARY KEY (id)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_sistema_serie' AND object_id = OBJECT_ID('dbo.radios_sistema'))
    CREATE INDEX IX_radios_sistema_serie ON dbo.radios_sistema(num_serie);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_sistema_indicativo' AND object_id = OBJECT_ID('dbo.radios_sistema'))
    CREATE INDEX IX_radios_sistema_indicativo ON dbo.radios_sistema(indicativo);
GO

-- ── 6. Conferência (folha `Quest`) ─────────────────────────
-- As 405 respostas ao questionário de Outubro/2025: cada agente disse se tem
-- rádio, qual o número e quantas baterias. É o que o parque diz de si próprio,
-- visto do outro lado — e é por isso que fica guardado tal como respondido,
-- sem correcções. As divergências são o produto, não um defeito a limpar.
IF OBJECT_ID('dbo.radios_conferencia', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_conferencia (
        id                   INT IDENTITY(1,1) NOT NULL,
        origem_id            INT           NULL,   -- Id da resposta no Forms (há negativos, são de teste)
        data_resposta        DATE          NULL,
        data_resposta_texto  NVARCHAR(40)  NULL,   -- o cru "17-Oct-25", para o que não converter
        email                NVARCHAR(200) NULL,
        nome                 NVARCHAR(200) NULL,
        matricula            INT           NULL,
        tem_radio            VARCHAR(10)   NULL,   -- SIM | NAO (normalizado; a origem tem "Não"/"NÃO")
        indicativo_declarado NVARCHAR(20)  NULL,
        baterias             INT           NULL,
        obs                  NVARCHAR(MAX) NULL,
        importado_em         DATETIME      NOT NULL CONSTRAINT DF_radios_conferencia_importado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_conferencia PRIMARY KEY (id)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_conferencia_matricula' AND object_id = OBJECT_ID('dbo.radios_conferencia'))
    CREATE INDEX IX_radios_conferencia_matricula ON dbo.radios_conferencia(matricula);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_radios_conferencia_indicativo' AND object_id = OBJECT_ID('dbo.radios_conferencia'))
    CREATE INDEX IX_radios_conferencia_indicativo ON dbo.radios_conferencia(indicativo_declarado);
GO

-- ── 7. Registo das importações ─────────────────────────────
-- Quem correu o importador, sobre que ficheiro, e o que entrou. Sem isto, dois
-- meses depois ninguém sabe se o que está na base é do ficheiro de Julho ou de
-- Outubro.
IF OBJECT_ID('dbo.radios_importacoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.radios_importacoes (
        id            INT IDENTITY(1,1) NOT NULL,
        ficheiro      NVARCHAR(400) NULL,
        resumo        NVARCHAR(MAX) NULL,   -- JSON: linhas lidas/inseridas por folha
        executado_por NVARCHAR(120) NULL,
        executado_em  DATETIME      NOT NULL CONSTRAINT DF_radios_importacoes_em DEFAULT (GETDATE()),
        CONSTRAINT PK_radios_importacoes PRIMARY KEY (id)
    );
END
GO

-- ── 8. Grupos de acesso ────────────────────────────────────
-- Mesmo padrão da correspondência (017): `tipo='acl'` distingue estes grupos de
-- acesso dos orgânicos.
--   IGA             → ver + registar/editar
--   IGA-Consulta    → só ver
--   IGA-Admin       → + abater e apagar registos
--
-- Os grupos são do MÓDULO e não dos rádios: valem para os telemóveis (migração
-- 002) e para o equipamento que vier a seguir. Ficam nesta migração por ser a
-- primeira do módulo, não por serem dos rádios.
DECLARE @lider INT = 956627;

IF NOT EXISTS (SELECT 1 FROM dbo.colaboradores WHERE mecanografico = @lider)
BEGIN
    RAISERROR('001: mecanografico 956627 (lider dos grupos) nao existe em colaboradores — abortado.', 16, 1);
    RETURN;
END

IF NOT EXISTS (SELECT 1 FROM dbo.grupos WHERE nome = 'IGA')
    INSERT INTO dbo.grupos (nome, sigla, descricao, lider_mecanografico, tipo)
    VALUES ('IGA', 'IGA',
            'Acesso ao Inventário e Gestão de Ativos (ver + registar/editar)', @lider, 'acl');

IF NOT EXISTS (SELECT 1 FROM dbo.grupos WHERE nome = 'IGA-Consulta')
    INSERT INTO dbo.grupos (nome, sigla, descricao, lider_mecanografico, tipo)
    VALUES ('IGA-Consulta', 'IGA-C',
            'Inventário e Gestão de Ativos — só consulta (vê o equipamento, sem registar nem editar)', @lider, 'acl');

IF NOT EXISTS (SELECT 1 FROM dbo.grupos WHERE nome = 'IGA-Admin')
    INSERT INTO dbo.grupos (nome, sigla, descricao, lider_mecanografico, tipo)
    VALUES ('IGA-Admin', 'IGA-A',
            'Inventário e Gestão de Ativos — administração (abater, apagar)', @lider, 'acl');
GO

-- ── 9. Membros iniciais ────────────────────────────────────
-- Quem trata dos rádios no NSIC. A gestão daqui para a frente é pela consola
-- AD-PM, como qualquer outro grupo.
DECLARE @gEditar INT = (SELECT id FROM dbo.grupos WHERE nome = 'IGA');
DECLARE @gAdmin  INT = (SELECT id FROM dbo.grupos WHERE nome = 'IGA-Admin');

INSERT INTO dbo.grupo_membros (grupo_id, mecanografico, data_entrada, ativo)
SELECT @gEditar, m.mec, CAST(GETDATE() AS DATE), 1
FROM (VALUES (956627), (961425), (951088), (962046)) AS m(mec)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.grupo_membros gm
    WHERE gm.grupo_id = @gEditar AND gm.mecanografico = m.mec
);

INSERT INTO dbo.grupo_membros (grupo_id, mecanografico, data_entrada, ativo)
SELECT @gAdmin, m.mec, CAST(GETDATE() AS DATE), 1
FROM (VALUES (956627), (951088)) AS m(mec)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.grupo_membros gm
    WHERE gm.grupo_id = @gAdmin AND gm.mecanografico = m.mec
);
GO

PRINT '001_radios: OK';
GO
