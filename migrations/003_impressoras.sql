-- ============================================================
-- 003 — Impressoras: o terceiro tipo, e o primeiro sem pessoas
--
-- Substitui o `impressoras Konica.xlsx` (C:\Apps\, uma folha, 16 linhas) que era
-- o registo das multifunções Konica Minolta espalhadas pelos serviços.
--
-- PORQUÊ — só o equipamento, sem atribuições, avarias nem abates
-- ---------------------------------------------------------------
-- Os outros dois tipos têm a mesma forma: equipamento + `_atribuicoes` +
-- `_avarias` + `_abates`. Aqui não. **Uma impressora não é entregue a ninguém**
-- — está instalada num serviço, e o que se quer saber dela é onde está. Repetir
-- a forma dava três tabelas que ninguém escreve e quatro estados dos quais só um
-- alguma vez aparecia; o ecrã ficava cheio de botões desligados.
--
-- Por isso **não há coluna `estado`**: sem avarias nem abates, ela seria
-- 'disponivel' em todas as linhas para sempre, e havia de enganar quem a lesse.
-- Se um dia as impressoras passarem a ter avarias registadas, isso é ficheiro
-- novo — `004_impressoras_avarias.sql` — com a coluna e o `recalcularEstado()`
-- a acompanhar, no molde dos outros dois.
--
-- PORQUÊ — a localização é uma coluna, não um histórico
-- ------------------------------------------------------
-- O que foi pedido é saber **onde cada impressora está**, não por onde andou. A
-- folha de origem também só tem "Localização Atual", uma célula por máquina: não
-- há histórico nenhum para carregar, e inventá-lo era encher a base de linhas de
-- uma data fingida. Se vier a ser preciso saber QUANDO mudou de serviço, a
-- tabela `impressoras_localizacoes` entra depois, no molde do `_atribuicoes`, e
-- esta coluna passa a ser a leitura da linha aberta.
--
-- PORQUÊ — base do módulo, sem pool própria
-- -------------------------------------------
-- As impressoras ficam na base apontada pelo `DB_DATABASE` (em desenvolvimento a
-- `RadiosDev`), com a pool do `db.js`. Os telemóveis têm pool própria porque têm
-- base própria — uma decisão de desenvolvimento, ver a 002. Aqui não há segunda
-- base, portanto não há segunda pool: um ficheiro `db-impressoras.js` era uma
-- ligação a mais para chegar exactamente ao mesmo sítio.
--
-- Como no resto do módulo, **este SQL nunca qualifica a base**.
--
-- O IP GUARDA-SE SEM OS ZEROS À ESQUERDA
-- ---------------------------------------
-- Na origem os IP estão escritos de duas maneiras: `10.22.129.60` numa linha e
-- `10.22.129.049` na seguinte. É a mesma forma de endereço, escrita por mãos
-- diferentes, e a base guarda uma só — a canónica, sem zeros, que é a que o
-- Windows, o `ping` e o painel da própria impressora mostram. Sem isso a mesma
-- máquina tinha duas escritas possíveis, e a procura por "129.49" não encontrava
-- a linha que dizia "129.049".
--
-- A conversão é do endereço, não do que ele identifica — `.049` e `.49` são o
-- mesmo host —, e vive em `normalizarIP()`, em duas cópias: no router (o que
-- entra pelo ecrã) e no importador (o que vem da folha). Só toca em IPv4 bem
-- formados; tudo o resto no campo passa intacto.
--
-- A coluna continua NVARCHAR e **sem índice único**. Já não é por causa das duas
-- escritas — essas deixaram de existir —, é porque o IP não é a identidade da
-- máquina: muda quando ela muda de sala, e duas fichas com o mesmo endereço são
-- um engano a resolver com os olhos, não um erro a barrar na gravação. A
-- identidade é o número de série e o host name, esses sim únicos.
--
-- ⚠️ UMA LINHA DA ORIGEM NÃO BATE CERTO CONSIGO PRÓPRIA
-- ------------------------------------------------------
-- Em quinze das dezasseis linhas o `HOST NAME` acaba no último octeto do IP
-- (`10.22.129.246` → `CML182_KO_246`). A excepção é a impressora da AADIVPOL:
-- IP `10.22.129.60`, host `CML182_KO_050`. Um dos dois valores está errado e a
-- folha não diz qual. **Entram os dois como estão** — corrigir por dedução era
-- inventar; quem for ao serviço confirma e corrige pelo ecrã.
--
-- Os grupos de acesso são os mesmos da 001 — `IGA`, `IGA-Consulta` e
-- `IGA-Admin`: é o mesmo módulo, não uma aplicação nova.
--
-- Idempotente: pode correr as vezes que forem precisas.
-- Alvo: SQL Server, base do `DB_DATABASE` (`RadiosDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;

-- ── 1. As máquinas ─────────────────────────────────────────
IF OBJECT_ID('dbo.impressoras', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.impressoras (
        id            INT IDENTITY(1,1) NOT NULL,
        marca         NVARCHAR(40)  NULL,   -- Konica Minolta
        modelo        NVARCHAR(80)  NULL,   -- bizhub 4700i, bizhub C458, bizhub 360i
        num_serie     NVARCHAR(40)  NULL,   -- ACTA021002692 (a chave do parque)
        localizacao   NVARCHAR(160) NULL,   -- 'DT - RADARES', 'FISC 1 - Sala Chefes'
        ip            NVARCHAR(45)  NULL,   -- ⚠️ texto, como vem da folha (ver acima)
        host_name     NVARCHAR(60)  NULL,   -- CML182_KO_246
        obs           NVARCHAR(MAX) NULL,
        criado_em     DATETIME      NOT NULL CONSTRAINT DF_impressoras_criado_em DEFAULT (GETDATE()),
        atualizado_em DATETIME      NOT NULL CONSTRAINT DF_impressoras_atualizado_em DEFAULT (GETDATE()),
        CONSTRAINT PK_impressoras PRIMARY KEY (id)
    );
END
GO

-- Único *quando existe*, como o número de série dos rádios e o número dos
-- telemóveis. É por aqui que o importador reconhece a máquina que já lá está, em
-- vez de criar uma segunda; filtrado porque uma máquina pode entrar no ecrã sem
-- a chapa à mão.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_impressoras_num_serie' AND object_id = OBJECT_ID('dbo.impressoras'))
    CREATE UNIQUE INDEX UX_impressoras_num_serie ON dbo.impressoras(num_serie) WHERE num_serie IS NOT NULL;
GO

-- O host name é único na rede, e o duplicado aqui é um erro a sério — duas
-- fichas para a mesma máquina. Ao contrário do IP, não tem formas alternativas
-- de se escrever, portanto o índice único faz o que promete.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_impressoras_host_name' AND object_id = OBJECT_ID('dbo.impressoras'))
    CREATE UNIQUE INDEX UX_impressoras_host_name ON dbo.impressoras(host_name) WHERE host_name IS NOT NULL;
GO

-- Índice normal, não único: ver a nota sobre os zeros à esquerda.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_impressoras_ip' AND object_id = OBJECT_ID('dbo.impressoras'))
    CREATE INDEX IX_impressoras_ip ON dbo.impressoras(ip);
GO

-- A pergunta que esta tabela existe para responder: quem está onde.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_impressoras_localizacao' AND object_id = OBJECT_ID('dbo.impressoras'))
    CREATE INDEX IX_impressoras_localizacao ON dbo.impressoras(localizacao);
GO

-- ── 2. Registo das importações ─────────────────────────────
-- Igual ao `radios_importacoes` da 001 e ao `telemoveis_importacoes` da 002.
-- Partilha a base com o primeiro, e mesmo assim é tabela própria: o que se quer
-- saber é de que ficheiro vieram ESTAS linhas.
IF OBJECT_ID('dbo.impressoras_importacoes', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.impressoras_importacoes (
        id            INT IDENTITY(1,1) NOT NULL,
        ficheiro      NVARCHAR(400) NULL,
        resumo        NVARCHAR(MAX) NULL,   -- JSON: linhas lidas, criadas, actualizadas
        executado_por NVARCHAR(120) NULL,
        executado_em  DATETIME      NOT NULL CONSTRAINT DF_impressoras_importacoes_em DEFAULT (GETDATE()),
        CONSTRAINT PK_impressoras_importacoes PRIMARY KEY (id)
    );
END
GO

PRINT '003_impressoras: OK';
GO
