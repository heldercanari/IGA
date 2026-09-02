# Gestão de Rádios — Polícia Municipal de Lisboa

Módulo destacado da intranet da PM para gerir o parque de rádios TETRA: quem tem o quê, o
que está avariado, o que foi abatido, e a conferência contra o questionário aos agentes.

Substitui o ficheiro `Radios apanhado.xlsx` (OneDrive, 7 folhas) que era o registo único.

> Este repositório é **um módulo destacado**, não um projecto autónomo — mesmo molde do
> `correspondencia-pm`. A casa a sério do código é o repositório da intranet; aqui está só o
> módulo dos rádios, com o mínimo à volta para arrancar. Os caminhos
> (`server/routes/radios/…`, `public/radios.html`) são os mesmos da intranet de propósito,
> para a cópia ser ficheiro-a-ficheiro.

## Montar

Preciso: Node ≥ 16, SQL Server (Express chega) e o `sqlcmd`.

```bash
npm install
```

```bash
cp .env.example .env
```

Preencher o `.env` com a instância local. ⚠️ **Sem `#` na password**: o `dotenv` corta o valor
no primeiro cardinal de um valor sem aspas e o que chega ao driver é só o princípio.

### Base de dados

Criar a base e o login (autenticação Windows, uma vez só):

```bash
sqlcmd -S localhost -E -I -Q "CREATE DATABASE RadiosDev"
```

```bash
sqlcmd -S localhost -E -I -d RadiosDev -Q "CREATE LOGIN radios_dev WITH PASSWORD='...', CHECK_POLICY=OFF; CREATE USER radios_dev FOR LOGIN radios_dev; ALTER ROLE db_owner ADD MEMBER radios_dev;"
```

Correr as migrações **por esta ordem** e **sempre com `-f 65001`** (ver os gotchas):

```bash
sqlcmd -S localhost -E -d RadiosDev -I -f 65001 -i migrations\000_seed_local.sql
```

```bash
sqlcmd -S localhost -E -d RadiosDev -I -f 65001 -i migrations\001_radios.sql
```

- `000_seed_local.sql` — andaime de desenvolvimento: cria `colaboradores`, `grupos`,
  `grupo_membros` e `admin_users` com utilizadores de teste. **Não é uma migração da
  intranet**; lá estas tabelas já existem.
- `001_radios.sql` — o módulo: tabelas do parque e os três grupos de acesso.

### Carregar os dados do Excel

```bash
npm run importar
```

Procura o `Radios apanhado.xlsx` no OneDrive da CML. Para outro caminho:

```bash
npm run importar -- "C:\caminho\Radios apanhado.xlsx"
```

Pode correr as vezes que forem precisas — procura por número de série e, na falta dele, por
indicativo, e não duplica. `npm run importar -- --limpar` esvazia o parque antes (só para
desenvolvimento: apaga o que foi registado pelo ecrã).

O importador imprime no fim um resumo por folha e as **notas** — as linhas do ficheiro que
contam rádios sem os listar ("Existem mais 7 rádios Secura 2120 sem número"). São 39 rádios
que ninguém registou individualmente e que continuam por registar.

## Correr

```bash
npm run harness
```

→ <http://localhost:3943/radios.html>

O harness serve `public/` e monta o router com um utilizador injectado, no lugar do SSPI.
`ATOR` escolhe quem se está a fingir:

| ATOR | Acesso |
|---|---|
| `helder.canarias` (o que vem por omissão) | escrita + administração |
| `andreia.r.goncalves` | escrita, sem administração |
| `sem.acesso` | 403 na página e na API |

```bash
ATOR=sem.acesso npm run harness
```

Na intranet a sério não há harness nenhum: a identidade vem do Windows (SSPI) e o router é
montado pelo `server/index.js`.

## O que o módulo faz

**Parque** — 407 rádios com indicativo, número de série, marca/modelo, alias TETRA e estado
(entregue · disponível · avariado · abatido). Procura, filtros e exportação para CSV.

**Entregas** — uma linha por entrega, com data, guia e observações. Entregar a outra pessoa
fecha a entrega anterior em vez de a apagar, que é o que o ficheiro fazia.

**Avarias** — tipo, se é de programação (`P`) ou física (`*`), onde está o equipamento, e o
fecho (reparada ou irreparável).

**Abates** — o rádio sai do parque activo mas não é apagado; o histórico fica. Só administração.

**Conferência** — cruza as 405 respostas ao questionário com o registo e classifica cada
pessoa: confere · indicativo diferente · sem registo · não declarado · sem resposta. É aqui
que aparece o trabalho por fazer.

**Sistema TETRA** — as 715 linhas da exportação da consola, só de leitura. Cruzam-se com o
parque pelo número de série.

## API

Tudo debaixo de `/api/radios`. O gate de VER está aplicado ao router inteiro; as mutações
levam `exigirEdicao`, e o abate e a remoção `exigirAdmin`.

| Método | Rota | Quem |
|---|---|---|
| GET | `/permissoes` | aberto (responde `canView:false`) |
| GET | `/estatisticas` · `/radios` · `/radios/:id` · `/sistema` · `/conferencia` · `/utilizadores` | ver |
| POST · PUT | `/radios` · `/radios/:id` | editar |
| POST | `/radios/:id/atribuir` · `/devolver` · `/avarias` | editar |
| POST | `/avarias/:id/reparar` | editar |
| POST · DELETE | `/radios/:id/abate` | administração |
| DELETE | `/radios/:id` | administração |

## Grupos de acesso

| Grupo | Pode |
|---|---|
| `Radios` | ver + registar/editar |
| `Radios-Consulta` | só ver |
| `Radios-Admin` | + importar, abater e apagar |

A gestão é pela consola AD-PM, como qualquer outro grupo. O administrador da consola
(`admin_users`) entra em tudo **excepto** na administração do módulo — essa é só do grupo.

## Como isto chega a produção

Ramo novo → pull request neste repositório. Depois de aceite, as alterações são copiadas para
o repositório da intranet, e é aí que chegam a produção. **Este repositório não tem caminho
nenhum para lá.**
