# Inventário e Gestão de Ativos (IGA) — Polícia Municipal de Lisboa

Módulo destacado da intranet da PM para gerir o equipamento distribuído: quem tem o quê, o
que está avariado, o que foi abatido, e a conferência contra o questionário aos agentes.

**IGA** é o nome curto da aplicação, e é ele que está no código: pasta `server/routes/iga/`,
API `/api/iga/<tipo>`, assets em `public/iga/`, grupos `IGA`, `IGA-Consulta` e `IGA-Admin`.
Os nomes por tipo de equipamento — `radios`, `telemoveis`, as tabelas e as bases — não levam
o prefixo: pertencem ao tipo, não à aplicação.

Dois tipos de activo, uma página para cada:

- **Rádios** — 407 aparelhos TETRA. Substitui o `Radios apanhado.xlsx` (OneDrive, 7 folhas).
- **Telemóveis** — 300 aparelhos. Substitui o `Livro 1.xlsx` (`C:\Apps\telemoveis`, uma folha).

> Este repositório é **um módulo destacado**, não um projecto autónomo — mesmo molde do
> `correspondencia-pm`. A casa a sério do código é o repositório da intranet; aqui está só o
> módulo dos rádios, com o mínimo à volta para arrancar. Os caminhos
> (`server/routes/iga/…`, `public/<tipo>.html`) são os mesmos da intranet de propósito,
> para a cópia ser ficheiro-a-ficheiro.

**Uma página por tipo de equipamento**, independente das outras: `public/radios.html` e
`public/telemoveis.html`. Não há motor partilhado entre elas — é uma decisão tomada de olhos
abertos: cada página é dona do seu ecrã, e em troca uma correcção de comportamento tem de ser
repetida em todas. A secção *[Acrescentar um tipo de equipamento](#acrescentar-um-tipo-de-equipamento)*
diz o que é preciso tocar.

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
- `001_radios.sql` — os rádios: tabelas do parque e os três grupos de acesso.

### A segunda base: telemóveis

Os telemóveis vivem em base própria (`TelemoveisDev`). É uma decisão de desenvolvimento — **na
intranet os módulos partilham a mesma base** —, e por isso nenhum SQL qualifica a base: a
separação está toda na ligação, em `db-telemoveis.js`, apontada pelo `DB_DATABASE_TELEMOVEIS`.
Para juntar tudo numa base só, põe-se essa variável igual ao `DB_DATABASE` e corre-se a `002`
lá; não há uma linha de SQL para reescrever.

```bash
sqlcmd -S localhost -E -I -Q "CREATE DATABASE TelemoveisDev"
```

```bash
sqlcmd -S localhost -E -d TelemoveisDev -I -Q "CREATE USER radios_dev FOR LOGIN radios_dev; ALTER ROLE db_owner ADD MEMBER radios_dev;"
```

```bash
sqlcmd -S localhost -E -d TelemoveisDev -I -f 65001 -i migrations\002_telemoveis.sql
```

### Carregar os dados do Excel

```bash
npm run importar
```

```bash
npm run importar-telemoveis
```

O primeiro procura o `Radios apanhado.xlsx` no OneDrive da CML; o segundo lê o
`C:\Apps\telemoveis\Livro 1.xlsx`. Ambos aceitam um caminho e a bandeira `--limpar`, que
esvazia antes de importar (só para desenvolvimento: apaga o que foi registado pelo ecrã):

```bash
npm run importar-radios -- "C:\caminho\Radios apanhado.xlsx"
```

Podem correr as vezes que forem precisas — os rádios são procurados por número de série e, na
falta dele, por indicativo; os telemóveis pelo número do cartão e, na falta dele, pelo IMEI.

Os dois imprimem um resumo no fim. O dos rádios lista ainda as **notas** — as linhas do
ficheiro que contam rádios sem os listar ("Existem mais 7 rádios Secura 2120 sem número"): são
39 rádios que ninguém registou individualmente. O dos telemóveis conta as **linhas repetidas**
na folha (há uma).

## Correr

```bash
npm run harness
```

- **Entrada** → <http://localhost:3943/iga.html> (a raiz reencaminha para aqui)
- Rádios → <http://localhost:3943/radios.html>
- Telemóveis → <http://localhost:3943/telemoveis.html>

A entrada é a página a dar às pessoas e a pôr no menu da intranet: mostra um cartão por
equipamento com as contagens, e abre a página respectiva. O cabeçalho das páginas de
equipamento traz de volta a ela.

O harness serve `public/` e monta o router com um utilizador injectado, no lugar do SSPI.
`ATOR` escolhe quem se está a fingir:

| ATOR | Acesso |
|---|---|
| `helder.canarias` (o que vem por omissão) | escrita + administração |
| `andreia.r.goncalves` | escrita, sem administração |
| `sem.acesso` | 403 nas páginas e na API |

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

**Telemóveis** — 300 aparelhos com número, IMEI, serviço e estado, com as mesmas entregas,
avarias e abates dos rádios. As **credenciais do cartão e da conta** (PIN, PUK, utilizador e
palavra passe) não aparecem na listagem nem na exportação: só na ficha do aparelho, atrás de
"mostrar credenciais", e só para quem é `IGA-Admin`. Cada leitura fica no log.

> ⚠️ Dois avisos sobre as credenciais que vêm do ficheiro de origem: a **palavra passe é
> derivável do utilizador** nos 300 aparelhos (`pm251ind` → `pm251ind!`), e os **PIN perderam
> os zeros à esquerda** por a coluna ser numérica no Excel — o ecrã assinala os que têm menos
> de 4 dígitos, e não os completa: dez tentativas erradas pedem o PUK.

## API

Tudo debaixo de `/api/iga`. O gate de VER está aplicado ao router inteiro; as mutações
levam `exigirEdicao`, e o abate e a remoção `exigirAdmin`.

Cada tipo de equipamento tem o seu router debaixo do seu nome — `/api/iga/radios/…` e
`/api/iga/telemoveis/…` —, e o `/permissoes` é do módulo, comum aos dois.

| Método | Rota | Quem |
|---|---|---|
| GET | `/permissoes` | aberto (responde `canView:false`) |
| GET | `<tipo>/` · `<tipo>/:id` · `<tipo>/estatisticas` | ver |
| POST · PUT | `<tipo>/` · `<tipo>/:id` | editar |
| POST | `<tipo>/:id/atribuir` · `/devolver` · `/avarias` | editar |
| POST | `<tipo>/avarias/:id/reparar` | editar |
| POST · DELETE | `<tipo>/:id/abate` | administração |
| DELETE | `<tipo>/:id` | administração |
| GET | `radios/sistema` · `radios/conferencia` · `radios/utilizadores` | ver (só rádios) |
| GET | `telemoveis/:id/credenciais` | administração (só telemóveis) |

## Acrescentar um tipo de equipamento

Cada tipo é uma página e um router próprios. Para juntar, por exemplo, computadores:

1. **Migração** — `migrations/00N_computadores.sql`, no molde da `002`: a tabela do
   equipamento mais `_atribuicoes`, `_avarias` e `_abates`. Base própria ou a de um dos
   outros: é só uma variável no `.env` e uma pool.
2. **Rotas** — `server/routes/iga/computadores.js`, no molde do `telemoveis.js`, e uma
   linha no `index.js`: `router.use('/computadores', require('./computadores'))`.
3. **Importador**, se houver ficheiro de origem — `scripts/importar_computadores.js` e um
   `npm run` no `package.json`.
4. **Página** — `public/computadores.html`. O ponto de partida é o `telemoveis.html`, que é o
   mais simples dos dois.
5. **Cartão na página de entrada** — uma entrada em `TIPOS`, no `public/iga.html`: nome,
   descrição, ícone, página e caminho da API. É o único sítio onde a lista de tipos está
   escrita à mão: as páginas de equipamento não têm barra de navegação entre tipos (cada uma
   é dedicada ao seu), e a navegação faz-se toda pela entrada.
6. **Harness** — acrescentar o nome a `PAGINAS` no `_harness-iga.js`. Na intranet, a página
   entra no `server/index.js` de lá, gated por `exigirAcesso`.

Os grupos de acesso **não mudam**: são do módulo, valem para todos os tipos.

## Grupos de acesso

| Grupo | Pode |
|---|---|
| `IGA` | ver + registar/editar |
| `IGA-Consulta` | só ver |
| `IGA-Admin` | + importar, abater e apagar |

A gestão é pela consola AD-PM, como qualquer outro grupo. O administrador da consola
(`admin_users`) entra em tudo **excepto** na administração do módulo — essa é só do grupo.

## Como isto chega a produção

Ramo novo → pull request neste repositório. Depois de aceite, as alterações são copiadas para
o repositório da intranet, e é aí que chegam a produção. **Este repositório não tem caminho
nenhum para lá.**
