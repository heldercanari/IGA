-- ============================================================
-- 007 — Autos de abate, do lado da base dos telemóveis
--
-- A mesma alteração que a 006 faz ao `radios_abates`, para o
-- `telemoveis_abates` — que em desenvolvimento vive noutra base (ver a 002).
-- O raciocínio todo está na 006.
--
-- ⚠️ **O `auto_id` não tem FOREIGN KEY aqui**: o `autos_abate` está na base do
-- módulo, e uma FK não atravessa bases. A coerência fica a cargo do router.
-- Na intranet, onde as bases são uma só, pode ganhar a FK numa migração própria.
--
-- Idempotente. Alvo: base dos telemóveis (`TelemoveisDev` em desenvolvimento).
-- ============================================================

SET NOCOUNT ON;

IF COL_LENGTH('dbo.telemoveis_abates', 'estado') IS NULL
    ALTER TABLE dbo.telemoveis_abates ADD
        estado          VARCHAR(20)   NOT NULL CONSTRAINT DF_telemoveis_abates_estado DEFAULT ('abatido')
                        CONSTRAINT CK_telemoveis_abates_estado CHECK (estado IN ('proposto', 'abatido')),
        auto_id         INT           NULL,
        apto_doacao     BIT           NULL,
        caracteristicas NVARCHAR(400) NULL;
GO

PRINT '007_autos_abate_telemoveis: OK';
GO
