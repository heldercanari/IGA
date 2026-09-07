# Inventário e Gestão de Ativos (IGA) — Polícia Municipal de Lisboa

Módulo destacado da intranet da PM para gerir o equipamento distribuído: quem tem o quê, o
que está avariado, o que foi abatido, e a conferência contra o questionário aos agentes.

**IGA** é o nome curto da aplicação, e é ele que está no código: pasta `server/routes/iga/`,
API `/api/iga/<tipo>`, assets em `public/iga/`, grupos `IGA`, `IGA-Consulta` e `IGA-Admin`.
Os nomes por tipo de equipamento — `radios`, `telemoveis`, as tabelas e as bases — não levam
o prefixo: pertencem ao tipo, não à aplicação.

Quatro tipos de activo, uma página para cada:

- **Rádios** — parque TETRA. Fonte actual: `master radios.xlsx` (identificação) +
  `atribuidos.xlsx` (quem tem o quê) + `avarias.csv`, no próprio repositório (o que está
  avariado). Substituem o `Radios apanhado.xlsx` original (7 folhas) e as fontes TETRA que
  vieram depois — ficaram só no histórico do git.
- **Telemóveis** — 300 aparelhos. Substitui o `Livro 1.xlsx` (`C:\Apps\telemoveis`, uma folha).
- **Impressoras** — 16 multifunções Konica Minolta. Substitui o `impressoras Konica.xlsx`
  (`C:\Apps\`, uma folha). **Este tipo não segue o molde dos outros dois**: uma impressora não
  é entregue a ninguém, está instalada num serviço — não tem entregas, avarias, abates nem
  coluna `estado`. O que se guarda dela é onde está.
- **Máquinas fotográficas** — 15 Kodak PIXPRO WPZ2 com cartão de memória. Substitui a folha
  `Kodak PIXPRO` do `Kodak.xlsx` (`C:\Apps\`, o livro geral do NSIC com 27 folhas). **Tem
  entregas** — uma máquina é levantada por alguém —, mas não tem avarias, abates nem coluna
  `estado`: está entregue quem tiver um levantamento por devolver.

> Este repositório é **um módulo destacado**, não um projecto autónomo — mesmo molde do
> `correspondencia-pm`. A casa a sério do código é o repositório da intranet; aqui está só o
> módulo dos rádios, com o mínimo à volta para arrancar. Os caminhos
> (`server/routes/iga/…`, `public/<tipo>.html`) são os mesmos da intranet de propósito,
> para a cópia ser ficheiro-a-ficheiro.

**Uma página por tipo de equipamento**, independente das outras: `public/radios.html`,
`public/telemoveis.html`, `public/impressoras.html` e `public/maquinas.html`. Não há motor partilhado entre elas — é uma decisão tomada de olhos
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

```bash
sqlcmd -S localhost -E -d RadiosDev -I -f 65001 -i migrations\003_impressoras.sql
```

```bash
sqlcmd -S localhost -E -d RadiosDev -I -f 65001 -i migrations\004_maquinas.sql
```

- `000_seed_local.sql` — andaime de desenvolvimento: cria `colaboradores`, `grupos`,
  `grupo_membros` e `admin_users` com utilizadores de teste. **Não é uma migração da
  intranet**; lá estas tabelas já existem.
- `001_radios.sql` — os rádios: tabelas do parque e os três grupos de acesso.
- `003_impressoras.sql` — as impressoras. Corre **nesta base**, não numa terceira: as
  impressoras não têm base própria nem pool própria. Duas tabelas só, `impressoras` e
  `impressoras_importacoes` — sem `_atribuicoes`, `_avarias` nem `_abates`, e sem coluna
  `estado`; o ficheiro explica porquê.
- `004_maquinas.sql` — as máquinas fotográficas, também nesta base. Leva `maquinas_atribuicoes`
  (ao contrário das impressoras: uma máquina é levantada por alguém), mas continua sem
  `_avarias`, `_abates` e sem coluna `estado`.

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

### Carregar os dados

```bash
npm run importar-radios
```

```bash
npm run importar-telemoveis
```

```bash
npm run importar-impressoras
```

```bash
npm run importar-maquinas
```

O primeiro lê `C:\Apps\master radios.xlsx` (identificação), `C:\Apps\atribuidos.xlsx` (quem tem
cada rádio) e `avarias.csv` — este último dentro do próprio repositório, não em `C:\Apps\`,
porque é o único das três pensado para se editar directamente e ficar no histórico do git. Os
caminhos das duas primeiras estão fixos no topo do script, não são parâmetro. O segundo lê
`C:\Apps\telemoveis\Livro 1.xlsx`; o terceiro, `C:\Apps\impressoras Konica.xlsx`.

⚠️ **O quarto lê UMA folha de um livro com 27.** O `C:\Apps\Kodak.xlsx` é o inventário geral do
NSIC — impressoras, telemóveis, tablets, portáteis, GPS, cofres —, e o importador das máquinas
vai à folha `Kodak PIXPRO` **pelo nome**, nunca "a primeira folha" (a primeira é a das
impressoras Lexmark). Se a folha for renomeada, o script pára e lista as que existem.

### ⚠️ A base de dados manda

Desde 2026-09-07, **os importadores não escrevem por cima do que está na base**. A regra vive em
`scripts/_sincronizacao.js` e é a mesma nos quatro:

| | |
|---|---|
| campo **com valor** na base | fica como está, diga o ficheiro o que disser |
| campo **vazio** na base | é preenchido pelo ficheiro |
| linha que **não existe** | entra por inteiro |
| equipamento **já entregue** na base | não muda de mãos pela importação |
| o que o ficheiro diz **de diferente** | aparece no resumo, campo a campo, sem ser gravado |

A razão foi concreta: o IP de uma impressora foi corrigido pelo ecrã e a importação seguinte
desfez a correcção em silêncio. Um ecrã onde uma correcção não dura não serve para nada.

Na prática, os ficheiros passaram de **fonte** a **sugestão**: servem para trazer equipamento
novo e preencher o que a base não sabe. Quem tem o quê, e o valor certo de cada campo,
decide-se no ecrã. Uma corrida sobre dados já importados não muda nada — só diz onde é que a
folha e a base discordam.

**Duas excepções**, ambas deliberadas: o `avarias.csv` continua a mandar nas avarias que ele
próprio abriu (é escrito à mão no repositório para ser a interface das avarias, e tirar-lhe uma
linha continua a ser a forma de dizer "reparado"), e o `--limpar` do importador dos telemóveis
continua a apagar tudo — é uma escolha explícita de quem o corre, não uma corrida de rotina.

### O resto

Correm as vezes que forem precisas. Ao contrário do importador dos telemóveis, o dos rádios
**não tem `--limpar`**: sincroniza em vez de destruir, nunca apaga em bloco. O rádio é
encontrado pelo alias (a chave do master) ou pelo indicativo, a entrega por (rádio, matrícula) e
a avaria por (rádio, ainda aberta, aberta por este importador) — nada duplica.

Como o `atribuidos.xlsx` não tem datas, todas as entregas desta importação levam a mesma data
fixa no código (`DATA_ATRIBUICAO_PADRAO`) — é quando o levantamento foi feito, não quando a
entrega aconteceu de facto. O resumo no fim conta, por fonte, o que mudou: pessoas repetidas no
ficheiro (fica a última linha), as que reclamam um rádio que outra pessoa também reclama (ficam
de fora, dos dois lados, até se resolver na origem), números sem correspondência no master
(entram como ficha mínima) e avarias abertas, actualizadas ou dadas como reparadas desde a
corrida anterior. Ver `scripts/importar_radios.js` e o CLAUDE.md para o detalhe de cada regra.

O das impressoras também sincroniza e também **não tem `--limpar`**: encontra a máquina pelo
número de série e, na falta dele, pelo host name. **Tira os zeros à esquerda dos IP** (`10.22.129.049` → `10.22.129.49`) e conta no
resumo quantas linhas vinham assim — hoje três. No fim **avisa quando o host name não bate
certo com o último octeto do IP** — hoje uma linha, a da AADIVPOL; esse, o importador não
corrige, porque não há maneira de saber qual dos dois valores está errado.

## Correr

```bash
npm run harness
```

- **Entrada** → <http://localhost:3943/iga.html> (a raiz reencaminha para aqui)
- Rádios → <http://localhost:3943/radios.html>
- Telemóveis → <http://localhost:3943/telemoveis.html>
- Impressoras → <http://localhost:3943/impressoras.html>
- Máquinas fotográficas → <http://localhost:3943/maquinas.html>

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

**Parque** — Alias, Rádio, N. Série, Estado, Atribuído, Data e Ações. O detalhe completo (TEI,
ISSI, marca/modelo, histórico de entregas e avarias) está na ficha, atrás do botão de ver — é lá
que o rádio se vê a sério, a tabela é só a lista. Procura, filtros e exportação para CSV
continuam a funcionar sobre as mesmas colunas.

**Entregas** — uma linha por entrega, com data, guia e observações. Entregar a outra pessoa
fecha a entrega anterior em vez de a apagar. Uma pessoa pode ter mais do que uma entrega aberta
ao mesmo tempo — acontece quando o `atribuidos.xlsx` descreve dois rádios na mesma célula.

**Avarias** — tipo, se é de programação (`P`) ou física (`*`), onde está o equipamento, e o
fecho (reparada ou irreparável). Fonte: `avarias.csv`, no próprio repositório — ver *As três
fontes actuais* no CLAUDE.md para o formato e a sincronização. Continua a poder registar-se
pelo ecrã (avaria pontual, fora do ficheiro); o importador só mexe nas que ele próprio abriu,
nunca nas registadas à mão.

**Abates** — o rádio sai do parque activo mas não é apagado; o histórico fica. Só administração.
Mesma situação das avarias: sem fonte nas folhas actuais.

**Conferência e Sistema TETRA** — as rotas e a lógica continuam no código
(`/api/iga/radios/conferencia`, `/sistema`), mas os separadores saíram do ecrã (2026-09-04,
junto com a limpeza da base) e nenhuma das duas folhas de que dependiam continua a ser
importada. Sem uso actual; não removidos por não haver ainda a certeza de que o novo par de
ficheiros não vai precisar de algo parecido.

**Telemóveis** — 300 aparelhos com número, IMEI, serviço e estado, com as mesmas entregas,
avarias e abates dos rádios. As **credenciais do cartão e da conta** (PIN, PUK, utilizador e
palavra passe) não aparecem na listagem nem na exportação: só na ficha do aparelho, atrás de
"mostrar credenciais", e só para quem é `IGA-Admin`. Cada leitura fica no log.

> ⚠️ Dois avisos sobre as credenciais que vêm do ficheiro de origem: a **palavra passe é
> derivável do utilizador** nos 300 aparelhos (`pm251ind` → `pm251ind!`), e os **PIN perderam
> os zeros à esquerda** por a coluna ser numérica no Excel — o ecrã assinala os que têm menos
> de 4 dígitos, e não os completa: dez tentativas erradas pedem o PUK.

**Impressoras** — 16 multifunções Konica Minolta com marca, modelo, número de série, IP, host
name e o serviço onde estão. **É o ecrã mais pequeno dos três, e não por estar por acabar**: as
impressoras não são entregues a pessoas, não têm avarias nem abates registados aqui, e por isso
não há estado nenhum a acompanhar. As acções são ver a ficha, **mudar de serviço** (a do
dia-a-dia), editar e apagar. Os KPI contam o sítio — instaladas, serviços diferentes, modelos e
as que estão sem local, que é a única coisa aqui que é trabalho por fazer.

Guarda-se onde a impressora **está**, não por onde andou: não há histórico de localizações, só
a data da última alteração. Se vier a ser preciso saber quando mudou de sítio, isso é migração
nova com uma tabela `impressoras_localizacoes` — ver a `003`.

Os **IP guardam-se sem zeros à esquerda**: a folha escreve-os de duas maneiras
(`10.22.129.60` numa linha, `10.22.129.049` noutra) e a base guarda a forma canónica, a mesma
que o Windows e o painel da impressora mostram. Vale para o que entra pela importação e para o
que se escreve no ecrã.

> ⚠️ Numa das dezasseis linhas o **host name não bate certo com o IP** (AADIVPOL: IP `.60`,
> host `_050`). Esse **não** foi corrigido: ao contrário dos zeros à esquerda, aqui não há
> maneira de saber qual dos dois valores está errado. O ecrã assinala a linha com um triângulo
> âmbar e explica-a na ficha; o aviso desaparece sozinho quando o valor certo for gravado.

**Máquinas fotográficas** — 15 Kodak PIXPRO WPZ2. A tabela tem cinco colunas — **ID-PM, Marca,
N. Série, Atribuído e Ações** — e **o resto da informação vive na ficha**: modelo, marca do
cartão de memória, capacidade e o histórico de levantamentos. É a mesma divisão do ecrã dos
rádios: a tabela é a lista, a máquina vê-se a sério na ficha.

Entregar a outra pessoa fecha o levantamento anterior em vez de o apagar, como nos rádios e nos
telemóveis. **A data de levantamento é opcional**, ao contrário dos outros dois: a folha de
origem datou um dos quatro e o ecrã tem de poder registar o mesmo sem inventar um dia — as
linhas por datar aparecem a âmbar na coluna "Atribuído" e contadas no KPI "Sem data".

A **capacidade guarda-se como `32 GB`**: a folha escreve-a de três maneiras ("32Gb", "32GB",
"32 Gb") e a base guarda uma, com o `B` de *byte* em maiúscula (o `b` minúsculo é *bit*, e um
cartão de "32 Gb" à letra tinha 4 GB) e o espaço que separa o número da unidade. Vale para o
que entra pela importação e para o que se escreve no ecrã; arruma-se a unidade, nunca o número.

> ⚠️ Duas coisas que vêm da folha e ficaram como estavam: a **marca diz "Kodak W" ou "Kodak R"**
> (o W e o R distinguem alguma coisa que a folha não explica, e parti-los era inventar o
> significado de uma letra) e a coluna "Levantou" traz o **username e não o nome**
> (`claudino.antunes`), com a matrícula ao lado. O ecrã tem o autocompletar do
> `/radios/utilizadores` para quem quiser escrever o nome a sério por cima.

## API

Tudo debaixo de `/api/iga`. O gate de VER está aplicado ao router inteiro; as mutações
levam `exigirEdicao`, e o abate e a remoção `exigirAdmin`.

Cada tipo de equipamento tem o seu router debaixo do seu nome — `/api/iga/radios/…`,
`/api/iga/telemoveis/…`, `/api/iga/impressoras/…` e `/api/iga/maquinas/…` —, e o `/permissoes`
é do módulo, comum aos quatro.

| Método | Rota | Quem |
|---|---|---|
| GET | `/permissoes` | aberto (responde `canView:false`) |
| GET | `<tipo>/` · `<tipo>/:id` · `<tipo>/estatisticas` | ver |
| POST · PUT | `<tipo>/` · `<tipo>/:id` | editar |
| POST | `<tipo>/:id/atribuir` · `/devolver` | editar (menos impressoras) |
| POST | `<tipo>/:id/avarias` | editar (rádios e telemóveis) |
| POST | `<tipo>/avarias/:id/reparar` | editar (rádios e telemóveis) |
| POST · DELETE | `<tipo>/:id/abate` | administração (rádios e telemóveis) |
| DELETE | `<tipo>/:id` | administração |
| GET | `radios/sistema` · `radios/conferencia` · `radios/utilizadores` | ver (só rádios) |
| GET | `telemoveis/:id/credenciais` | administração (só telemóveis) |
| GET | `impressoras/locais` | ver (só impressoras) |

⚠️ **O `PUT` das impressoras e das máquinas grava só os campos que vierem no corpo**; o dos
rádios e dos telemóveis grava a lista toda e apaga o que não vier. É deliberado: nas
impressoras a acção mais comum é mudar uma de serviço, um pedido com um campo só, e com a regra
dos outros isso apagava o IP, a série e o modelo.

## Acrescentar um tipo de equipamento

Cada tipo é uma página e um router próprios. Para juntar, por exemplo, computadores:

1. **Migração** — `migrations/00N_computadores.sql`, no molde da `002`: a tabela do
   equipamento mais `_atribuicoes`, `_avarias` e `_abates`. Base própria ou a de um dos
   outros: é só uma variável no `.env` e uma pool.
2. **Rotas** — `server/routes/iga/computadores.js`, no molde do `telemoveis.js`, e uma
   linha no `index.js`: `router.use('/computadores', require('./computadores'))`.
3. **Importador**, se houver ficheiro de origem — `scripts/importar_computadores.js` e um
   `npm run` no `package.json`.
4. **Página** — `public/computadores.html`. O ponto de partida é o `telemoveis.html` para um
   tipo que se entrega a pessoas, ou o `impressoras.html` para um que não se entregue.
5. **Cartão na página de entrada** — uma entrada em `TIPOS`, no `public/iga.html`: nome,
   descrição, ícone, página, caminho da API e as `contagens` do rodapé do cartão — de uma a
   quatro, e a grelha ajusta-se (o `campo` de cada uma é a chave que vem do `/estatisticas`
   desse tipo; os tipos com o parque completo partilham a lista `CONTAGENS_PARQUE`). **Não
   inventes números para encher as quatro**: as máquinas fotográficas mostram três. É o único sítio onde a lista de tipos está
   escrita à mão: as páginas de equipamento não têm barra de navegação entre tipos (cada uma
   é dedicada ao seu), e a navegação faz-se toda pela entrada.
6. **Harness** — acrescentar o nome a `PAGINAS` no `_harness-iga.js`. Na intranet, a página
   entra no `server/index.js` de lá, gated por `exigirAcesso`.

Os grupos de acesso **não mudam**: são do módulo, valem para todos os tipos.

**O molde não é obrigatório, escolhe-se por peça** — as impressoras (`003`) e as máquinas
fotográficas (`004`) são os precedentes, e escolheram diferente:

| | `_atribuicoes` | `_avarias` / `_abates` | coluna `estado` |
|---|---|---|---|
| rádios, telemóveis | sim | sim | sim, com `recalcularEstado()` |
| impressoras | **não** — não se entregam | não | **não** |
| máquinas fotográficas | **sim** — levantam-se | não | **não** — lê-se da entrega aberta |

Um tipo que não se entregue a pessoas não leva `_atribuicoes`; um que não tenha avarias
registadas não leva `_avarias` nem `_abates`. E **a coluna `estado` só se justifica com a
precedência dos quatro valores** (abatido > avariado > atribuído > disponível) a vir de três
tabelas: com uma tabela só, a pergunta faz-se onde é precisa e não há segunda fonte de verdade
para desalinhar. Repetir a forma por simetria dá tabelas que ninguém escreve e botões
desligados no ecrã. O que não muda são os seis passos acima e os grupos de acesso.

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
