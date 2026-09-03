-- ============================================================
-- 002 — Telemóveis: o segundo tipo de activo entra no módulo
--
-- Substitui o `Livro 1.xlsx` (C:\Apps\telemoveis, uma folha) que era o registo
-- dos 301 telemóveis de serviço. O módulo passa a ter dois separadores sobre a
-- mesma casa: rádios e telemóveis.
--
-- PORQUÊ — tabelas próprias e não uma tabela de "activos"
-- --------------------------------------------------------
-- Tentador era generalizar `radios` para `ativos` com uma coluna `tipo`. Não se
-- fez, e a razão é o formato dos dois: um rádio tem indicativo, alias TETRA, ID
-- de rádio e TIE; um telemóvel tem IMEI, número, PIN, PUK, utilizador e palavra
-- passe. São catorze colunas que não se cruzam — juntá-las dava uma tabela larga
-- onde metade de cada linha é NULL, e um `CHECK` por tipo para dizer que colunas
-- valem para quem. As duas tabelas têm a MESMA FORMA (equipamento + atribuições
-- + avarias + abates) e é essa forma que se repete, não as colunas.
--
-- PORQUÊ — as credenciais ficam mas não se mostram
-- -------------------------------------------------
-- O ficheiro de origem traz PIN, PUK, utilizador e palavra passe de cada
-- telemóvel, à vista de quem abrisse a folha. Aqui ficam guardadas — são precisas
-- a quem entrega o equipamento — mas **fora do que a listagem devolve**: só a
-- rota `/telemoveis/:id/credenciais`, reservada ao grupo `IGA-Admin`, as lê.
-- Não são credenciais de acesso a esta aplicação (essa vem do Windows): são do
-- cartão SIM e da conta do próprio aparelho.
--
-- ⚠️ **A palavra passe é derivável do utilizador** em todos os 301 registos:
-- `pm251ind` → `pm251ind!`. Isto está aqui registado porque é um facto do
-- material, não porque seja aceitável — quem gerir a frota que decida.
--
-- PORQUÊ — o PIN fica como está, sem zeros à esquerda
-- ---------------------------------------------------
-- Na folha o PIN é numérico, portanto o Excel comeu os zeros à esquerda: um PIN
-- "0020" está gravado como 20. Guarda-se **o que lá está**, em texto, sem
-- completar: um PIN inventado tranca o cartão, e ao fim de dez tentativas o PUK
-- também. O ecrã avisa quando o valor tem menos de 4 dígitos.
--
-- PORQUÊ — base de dados própria, e como se desfaz isso
-- ------------------------------------------------------
-- Em desenvolvimento os telemóveis vivem na base `TelemoveisDev`, separada da
-- `RadiosDev`. É uma decisão de desenvolvimento, não de arquitectura: **na
-- intranet os módulos partilham a mesma base**, e é para lá que isto vai.
--
-- Por isso o SQL daqui NUNCA qualifica a base nem usa nomes de três partes
-- (`TelemoveisDev.dbo.telemoveis`). A separação vive toda na ligação — uma
-- segunda pool em `db-telemoveis.js`, apontada pelo `DB_DATABASE_TELEMOVEIS` do
-- `.env`. Para juntar tudo numa base só, põe-se essa variável com o mesmo valor
-- do `DB_DATABASE` e corre-se este ficheiro lá: não há uma linha de SQL para
-- reescrever.
--
-- Os grupos de acesso são os mesmos da 001 — `IGA`, `IGA-Consulta` e
-- `IGA-Admin`: é o mesmo módulo, não uma aplicação nova. Como esses grupos
-- vivem noutra base, esta migração não lhes toca.
--
-- Idempotente: pode correr as vezes que forem precisas.
-- Alvo: SQL Server, base `TelemoveisDev` em desenvolvimento.
-- ============================================================

SET NOCOUNT ON;

-- ── 1. Os aparelhos ────────────────────────────────────────
IF OBJECT_ID('dbo.telemoveis', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.telemoveis (
        id             INT IDENTITY(1,1) NOT NULL,
        numero         NVARCHAR(20)  NULL,   -- 914699022 (cartão Vodafone)
        imei1          NVARCHAR(30)  NULL,   -- ⚠️ na origem só os últimos dígitos
        imei2          NVARCHAR(30)  NULL,   -- o segundo slot do aparelho
        marca          NVARCHAR(40)  NULL,
        modelo         NVARCHAR(80)  NULL,
        pin            NVARCHAR(20)  NULL,   -- credencial: só administração
        puk            NVARCHAR(20)  NULL,   -- credencial: só administração
        utilizador     NVARCHAR(60)  NULL,   -- credencial: só administração
        palavra_passe  NVARCHAR(60)  NULL,   -- credencial: só administração
        estado         VARCHAR(20)   NOT NULL CONSTRAINT DF_telemoveis_estado DEFAULT ('disponivel'),
        localizacao    NVARCHAR(120) NULL,   -- serviço onde está (NSIC, Com. ET, …)
        marcador       NVARCHAR(10)  NULL,   -- coluna 'OBS1' da folha: '*' ou '1', significado não documentado
        obs            NVARCHAR(MAX) NULL,
        criado_em      DATETIME      NOT NULL CONSTRAINT DF_telemoveis_criado_em DEFAULT (GETDATE()),
        atualizado_em  DATETIME      NOT NULL CONSTRAINT DF_telemoveis_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_telemoveis PRIMARY KEY (id),
        CONSTRAINT CK_telemoveis_estado CHECK (estado IN ('disponivel', 'atribuido', 'avariado', 'abatido'))
    );
END
GO

-- Único *quando existe*, como o número de série dos rádios. A folha tem 301
-- linhas para 300 aparelhos — a linha 124 aparece outra vez na 125, igual até ao
-- PIN —, e é este índice que faz a segunda cair em cima da primeira em vez de
-- criar um aparelho fantasma. Filtrado porque um aparelho pode ficar sem cartão.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_telemoveis_numero' AND object_id = OBJECT_ID('dbo.telemoveis'))
    CREATE UNIQUE INDEX UX_telemoveis_numero ON dbo.telemoveis(numero) WHERE numero IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_telemoveis_imei1' AND object_id = OBJECT_ID('dbo.telemoveis'))
    CREATE INDEX IX_telemoveis_imei1 ON dbo.telemoveis(imei1);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_telemoveis_estado' AND object_id = OBJECT_ID('dbo.telemoveis'))
    CREATE INDEX IX_telemoveis_estado ON dbo.telemoveis(estado);
GO

-- ── 2. Quem tem o quê ──────────────────────────────────────
IF OBJECT_ID('dbo.telemoveis_atribuicoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.telemoveis_atribuicoes (
        id              INT IDENTITY(1,1) NOT NULL,
        telemovel_id    INT           NOT NULL,
        matricula       INT           NULL,
        nome_utilizador NVARCHAR(200) NULL,
        data_entrega    DATE          NULL,
        data_devolucao  DATE          NULL,   -- NULL = ainda o tem
        obs             NVARCHAR(MAX) NULL,
        registado_por   NVARCHAR(120) NULL,
        criado_em       DATETIME      NOT NULL CONSTRAINT DF_telemoveis_atrib_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_telemoveis_atribuicoes PRIMARY KEY (id),
        CONSTRAINT FK_telemoveis_atribuicoes_tel FOREIGN KEY (telemovel_id)
            REFERENCES dbo.telemoveis(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_telemoveis_atribuicoes_tel' AND object_id = OBJECT_ID('dbo.telemoveis_atribuicoes'))
    CREATE INDEX IX_telemoveis_atribuicoes_tel ON dbo.telemoveis_atribuicoes(telemovel_id, data_devolucao);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_telemoveis_atribuicoes_matricula' AND object_id = OBJECT_ID('dbo.telemoveis_atribuicoes'))
    CREATE INDEX IX_telemoveis_atribuicoes_matricula ON dbo.telemoveis_atribuicoes(matricula);
GO

-- ── 3. Avarias ─────────────────────────────────────────────
-- Sem o par `ordem` ('P'/'*') dos rádios: num telemóvel não há avaria de
-- programação que se resolva no posto, e inventar a coluna para as duas tabelas
-- ficarem iguais era pôr no ecrã um campo que ninguém preenche.
IF OBJECT_ID('dbo.telemoveis_avarias', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.telemoveis_avarias (
        id             INT IDENTITY(1,1) NOT NULL,
        telemovel_id   INT           NOT NULL,
        descricao      NVARCHAR(200) NULL,   -- ecrã partido, software danificado, extraviado…
        estado         VARCHAR(20)   NOT NULL CONSTRAINT DF_telemoveis_avarias_estado DEFAULT ('aberta'),
        data_registo   DATE          NULL,
        data_reparacao DATE          NULL,
        obs            NVARCHAR(MAX) NULL,
        registado_por  NVARCHAR(120) NULL,
        criado_em      DATETIME      NOT NULL CONSTRAINT DF_telemoveis_avarias_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_telemoveis_avarias PRIMARY KEY (id),
        CONSTRAINT FK_telemoveis_avarias_tel FOREIGN KEY (telemovel_id)
            REFERENCES dbo.telemoveis(id) ON DELETE CASCADE,
        CONSTRAINT CK_telemoveis_avarias_estado CHECK (estado IN ('aberta', 'reparada', 'irreparavel'))
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_telemoveis_avarias_tel' AND object_id = OBJECT_ID('dbo.telemoveis_avarias'))
    CREATE INDEX IX_telemoveis_avarias_tel ON dbo.telemoveis_avarias(telemovel_id, estado);
GO

-- ── 4. Abates ──────────────────────────────────────────────
IF OBJECT_ID('dbo.telemoveis_abates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.telemoveis_abates (
        id            INT IDENTITY(1,1) NOT NULL,
        telemovel_id  INT           NOT NULL,
        data_abate    DATE          NULL,
        motivo        NVARCHAR(200) NULL,
        obs           NVARCHAR(MAX) NULL,
        registado_por NVARCHAR(120) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_telemoveis_abates_criado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_telemoveis_abates PRIMARY KEY (id),
        CONSTRAINT FK_telemoveis_abates_tel FOREIGN KEY (telemovel_id)
            REFERENCES dbo.telemoveis(id) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_telemoveis_abates_tel' AND object_id = OBJECT_ID('dbo.telemoveis_abates'))
    CREATE UNIQUE INDEX UX_telemoveis_abates_tel ON dbo.telemoveis_abates(telemovel_id);
GO

-- ── 5. Registo das importações ─────────────────────────────
-- Igual ao `radios_importacoes` da 001, e separado dele por estar noutra base:
-- quem consulta a base dos telemóveis tem de saber de que ficheiro vieram estas
-- linhas sem ir procurar do outro lado.
IF OBJECT_ID('dbo.telemoveis_importacoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.telemoveis_importacoes (
        id            INT IDENTITY(1,1) NOT NULL,
        ficheiro      NVARCHAR(400) NULL,
        resumo        NVARCHAR(MAX) NULL,   -- JSON: linhas lidas, criadas, atribuições, avarias, abates
        executado_por NVARCHAR(120) NULL,
        executado_em  DATETIME      NOT NULL CONSTRAINT DF_telemoveis_importacoes_em DEFAULT (GETDATE()),
        CONSTRAINT PK_telemoveis_importacoes PRIMARY KEY (id)
    );
END
GO

PRINT '002_telemoveis: OK';
GO
