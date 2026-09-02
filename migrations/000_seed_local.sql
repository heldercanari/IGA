-- ============================================================
-- 000 — Andaime para desenvolvimento local
--
-- A migração 001 assume que a intranet já existe à volta dela: precisa de
-- `colaboradores`, `grupos` e `grupo_membros` para criar os grupos de acesso e
-- pôr lá as pessoas. Este ficheiro cria versões mínimas dessas tabelas, com
-- utilizadores de teste, para que a 001 corra sem alterações numa base vazia.
--
-- NÃO é uma migração da intranet. Existe só neste repositório e só para dev:
-- na intranet a sério, `colaboradores` é uma vista sobre o cadastro de RH e
-- estas tabelas têm dezenas de colunas que aqui não interessam. É a cópia do
-- mesmo andaime do módulo de correspondência, de propósito — os dois módulos
-- lêem exactamente as mesmas colunas.
--
-- Ordem:
--   1. sqlcmd -S localhost -d RadiosDev -I -i migrations\000_seed_local.sql
--   2. sqlcmd -S localhost -d RadiosDev -I -i migrations\001_radios.sql
--
-- Idempotente: pode correr as vezes que forem precisas.
-- ============================================================

SET NOCOUNT ON;
GO

-- ── Pessoas ────────────────────────────────────────────────
-- Só as três colunas que `permissoes.js` lê: o username SSPI (`[user]`) resolve
-- para `mecanografico`, e o `nome` é o que aparece no ecrã. Os nomes aqui são
-- rótulos de teste de propósito — isto não é o cadastro.
IF OBJECT_ID('dbo.colaboradores', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.colaboradores (
        mecanografico INT           NOT NULL,
        nome          NVARCHAR(200) NULL,
        [user]        NVARCHAR(120) NULL,
        CONSTRAINT PK_colaboradores PRIMARY KEY (mecanografico)
    );
END
GO

MERGE dbo.colaboradores AS alvo
USING (VALUES
    (956627, N'Teste — escrita e administração', N'helder.canarias'),
    (961425, N'Teste — escrita sem administração', N'andreia.r.goncalves'),
    (951088, N'Teste — escrita e administração (2)', N'manuel.gomes'),
    (962046, N'Teste — administrador da consola',   N'sergio.m.antonio'),
    (900001, N'Teste — sem acesso nenhum',          N'sem.acesso')
) AS origem(mec, nome, usr)
ON alvo.mecanografico = origem.mec
WHEN NOT MATCHED THEN
    INSERT (mecanografico, nome, [user]) VALUES (origem.mec, origem.nome, origem.usr);
GO

-- ── Administradores da consola AD-PM ───────────────────────
-- `permissoes.js` consulta isto para o atalho de administrador: entra em tudo
-- excepto na administração do módulo, que é só do grupo.
IF OBJECT_ID('dbo.admin_users', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_users (
        username NVARCHAR(120) NOT NULL,
        ativo    BIT           NOT NULL CONSTRAINT DF_admin_users_ativo DEFAULT (1),
        CONSTRAINT PK_admin_users PRIMARY KEY (username)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.admin_users WHERE username = N'sergio.m.antonio')
    INSERT INTO dbo.admin_users (username, ativo) VALUES (N'sergio.m.antonio', 1);
GO

-- ── Grupos e membros ───────────────────────────────────────
-- `lider_mecanografico` é NOT NULL na intranet e a 001 conta com isso; fica
-- igual aqui para a migração correr sem ramos especiais.
IF OBJECT_ID('dbo.grupos', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.grupos (
        id                  INT IDENTITY(1,1) NOT NULL,
        nome                NVARCHAR(150)     NOT NULL,
        sigla               NVARCHAR(40)      NULL,
        descricao           NVARCHAR(400)     NULL,
        lider_mecanografico INT               NOT NULL,
        tipo                NVARCHAR(30)      NULL,
        CONSTRAINT PK_grupos PRIMARY KEY (id)
    );
END
GO

IF OBJECT_ID('dbo.grupo_membros', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.grupo_membros (
        id            INT IDENTITY(1,1) NOT NULL,
        grupo_id      INT               NOT NULL,
        mecanografico INT               NOT NULL,
        data_entrada  DATE              NULL,
        ativo         BIT               NOT NULL CONSTRAINT DF_grupo_membros_ativo DEFAULT (1),
        CONSTRAINT PK_grupo_membros PRIMARY KEY (id)
    );
END
GO

-- ── Um grupo orgânico, para o ecrã ter serviço ─────────────
-- Ao contrário da correspondência, aqui os grupos orgânicos não filtram nada
-- (um rádio não tem destinatário); ficam só para o cabeçalho mostrar o serviço
-- de quem está a ver.
IF NOT EXISTS (SELECT 1 FROM dbo.grupos WHERE nome = N'Núcleo de Sistemas de Informação e Comunicações')
    INSERT INTO dbo.grupos (nome, sigla, descricao, lider_mecanografico, tipo)
    VALUES (N'Núcleo de Sistemas de Informação e Comunicações', N'NSIC',
            N'Grupo orgânico de teste', 956627, N'organico');
GO

DECLARE @gOrganico INT = (SELECT id FROM dbo.grupos WHERE nome = N'Núcleo de Sistemas de Informação e Comunicações');

INSERT INTO dbo.grupo_membros (grupo_id, mecanografico, data_entrada, ativo)
SELECT @gOrganico, m.mec, CAST(GETDATE() AS DATE), 1
FROM (VALUES (956627), (961425), (951088), (962046)) AS m(mec)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.grupo_membros gm
    WHERE gm.grupo_id = @gOrganico AND gm.mecanografico = m.mec
);
GO

PRINT '000_seed_local: OK — correr agora a 001_radios.sql';
GO
