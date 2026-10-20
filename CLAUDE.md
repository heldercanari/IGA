# Inventário e Gestão de Ativos (IGA) — instruções para agentes

Este repositório é **um módulo destacado da intranet da Polícia Municipal de Lisboa**, não um
projecto autónomo. A casa a sério do código é o repositório da intranet; aqui está só o
inventário de equipamento, com o mínimo à volta para arrancar. É o mesmo molde do `correspondencia-pm`
(`C:\Apps\CorrespondenciaDEV\correspondencia-pm`) — quando houver dúvida sobre convenções, é lá
que se vai ver.

O `README.md` explica como montar e correr. Este ficheiro tem **apenas os gotchas** — o que não
se descobre a ler o código, e o que já correu mal antes.

## O nome

**IGA** é o nome curto da aplicação e é o que está no código: `server/routes/iga/`,
`/api/iga/<tipo>`, `public/iga/`, grupos `IGA`, `IGA-Consulta` e `IGA-Admin`, `req.igaUser`,
código de erro `IGA_SEM_ACESSO`. Nos ecrãs aparece só o nome por extenso — "Inventário e
Gestão de Ativos", **sem a sigla ao lado** (tirada a 2026-10-20) —; só o separador do browser
leva `· IGA`, que é o que lá cabe.

**Os nomes por tipo de equipamento não levam o prefixo**: `radios`, `telemoveis`,
`impressoras`, `maquinas`, as páginas, as tabelas (`radios_*`, `telemoveis_*`, `impressoras_*`,
`maquinas_*`) e as bases pertencem ao tipo, não à aplicação. Um tipo novo entra com o seu nome,
não com `iga_qualquer_coisa`.

**Os nomes de código são uma palavra**, mesmo quando o nome por extenso não é: as máquinas
fotográficas são `maquinas` nas tabelas, na API e na página, e **Máquina Fotográfica** só nos
ecrãs — a mesma divisão que o próprio IGA faz entre a sigla e o nome inteiro.

## O que não se altera aqui

- **`db.js` e `server/logger.js` são cópias inalteradas da intranet.** Se precisarem de mudar, é
  conversa para lá, não para este repositório.
- **`migrations/000_seed_local.sql` só existe neste repositório.** É andaime de desenvolvimento,
  não uma migração da intranet. Nunca o proponhas para lá.
- **`migrations/001_radios.sql` é a migração do módulo.** Enquanto não for para a intranet pode
  ser editada; a partir do momento em que correr em produção, alterações à base de dados são
  **ficheiro novo, numerado a seguir** (e na intranet o número vai ser outro — a correspondência
  ficou na 018).

## Ferramentas — três armadilhas locais

- ⚠️ **`sqlcmd` precisa de `-f 65001` para ficheiros com acentos.** Sem isso lê o ficheiro na
  codepage do sistema e grava mojibake na base ("administraÃ§Ã£o"). O erro não aparece à saída
  do `sqlcmd` — só quando a aplicação lê a linha.
- ⚠️ **Caminhos passados ao `sqlcmd` têm de levar barras invertidas.** O `sqlcmd` clássico aceita
  opções com `/`, portanto `-i C:/Users/…` faz o `/Users` ser lido como `-U sers` e a chamada
  morre com "-E and the -U/-P options are mutually exclusive".
- ⚠️ **Sem `#` nas passwords do `.env`.** O `dotenv` corta um valor sem aspas no primeiro
  cardinal, e o que chega ao driver é só o princípio — o erro que se vê é "Login failed".

## Não há importações

Decisão de 2026-10-13. **O inventário mantém-se só pelo ecrã**, à medida da necessidade, e a
base de dados é a única fonte. As folhas de origem serviram para a carga inicial e mais nada.

- **Os importadores saíram do repositório**: `scripts/importar_*.js`, o
  `scripts/_sincronizacao.js`, o `avarias.csv` e a dependência do `exceljs`. Estão no histórico
  do git (o último commit que os tem é o `25065c0`). **Não os ressuscites** para "pôr dados numa
  base nova" — copia-se a base que existe.
- **As tabelas `*_importacoes` ficam na base**, como registo da carga, mas nada as lê: o
  `/estatisticas` deixou de devolver `ultima_importacao` e a entrada deixou de mostrar a data.
  Não voltes a pôr uma "última importação" nos cartões — não há importação que ela possa datar.
- **Um tipo novo não traz importador.** Se um dia vier um ficheiro para carregar, é uma carga
  única e conversa a ter primeiro, não um script de rotina.

## Duas bases de dados, seis tipos

- **Os rádios estão na `RadiosDev` e os telemóveis na `TelemoveisDev`.** Duas pools: o `db.js`
  (cópia da intranet) e o `db-telemoveis.js`, que só existe por causa disto.
- **As impressoras, as máquinas fotográficas, os tablets e os GPS ficam na base do `db.js` — a mesma dos rádios — e
  não têm pool própria.** Base própria é a excepção que os telemóveis são, não a regra: um
  `db-impressoras.js` era uma terceira ligação para chegar ao mesmo sítio. Um tipo novo só leva
  pool quando levar base.
- ⚠️ **Nunca qualifiques a base no SQL.** Nada de `TelemoveisDev.dbo.telemoveis` nem de nomes
  de três partes: a separação vive na ligação, não nas consultas. **Na intranet os módulos
  partilham a mesma base**, e é assim que juntar tudo é apagar o `DB_DATABASE_TELEMOVEIS` do
  `.env` — sem tocar numa linha de SQL.
- Pela mesma razão **não há consultas que cruzem os dois tipos de activo**. Uma pessoa com um
  rádio e um telemóvel aparece nas duas listas, e não há JOIN possível entre elas.
- As rotas dos telemóveis estão em `server/routes/iga/telemoveis.js` **porque falam com a
  outra pool**, não por serem outro módulo: montam dentro do mesmo router e usam os mesmos
  grupos de acesso.
- O que os dois tipos partilham vive em `server/routes/iga/comum.js` (leitura de campos e
  datas). O recálculo do estado **não** está lá de propósito: conhece as tabelas de cada tipo.

## Base de dados

- **O alvo é SQL Server.** Não escrevas SQL a tentar ser portável, nem introduzas abstracções
  para isso.
- **O `estado` é uma coluna, não uma consulta** — e quem o escreve é o `recalcularEstado()` de
  cada tipo (`radios.js` e `telemoveis.js` têm o seu, porque conhecem as suas tabelas).
  Qualquer coisa que mexa em atribuições, avarias ou abates tem de o chamar a seguir; **SQL
  escrito à mão que apague uma dessas linhas deixa o estado desalinhado** (o `README` tem o
  UPDATE que repõe tudo). A precedência é abatido > avariado > atribuído > disponível.
- **Ao contrário da correspondência, aqui as datas são `DATE` a sério.** A origem trazia datas
  do Excel, não texto; a excepção é a folha `Quest`, cujas datas vêm em texto "17-Oct-25" e são
  convertidas na carga, com o cru guardado ao lado em `data_resposta_texto`.
- **`num_serie` é único mas só quando existe** (índice filtrado): os dois rádios criados sem
  ficha do master (ver abaixo) não têm série, e isso é esperado, não sujidade para limpar.
- **`indicativo` é efectivamente único agora.** As reatribuições nunca fechadas que existiam na
  folha antiga (357, 847, 849…) eram um artefacto dela — não existem no `master radios.xlsx`,
  cujo ALIAS é uma chave a sério. Se voltares a ver indicativos duplicados, é sinal de que algo
  está a criar rádios em vez de encontrar os que já existem.

## O que a carga inicial deixou na base

Os rádios vieram do `master radios.xlsx` (identificação), do `atribuidos.xlsx` (quem tem o
quê) e do `avarias.csv`; os telemóveis do `Livro 1.xlsx`. O que se segue não é sujidade para
limpar — é o rasto dessas folhas, e explica dados que de outro modo pareciam erros.

- ⚠️ **As entregas dos rádios vindas da carga têm todas a data 2025-10-01.** O
  `atribuidos.xlsx` não tinha datas; essa é a do levantamento, não a da entrega. A verdadeira
  perdeu-se e não se inventa.
- **Dois rádios ficaram sem entrega por terem duas pessoas a reclamá-los**, e o mesmo com o
  834 (um "34" mal transcrito que, corrigido, chocou com o dono legítimo). Resolvem-se pelo
  ecrã, entregando a quem for, quando se souber quem tem o rádio a sério.
- **Uma pessoa pode ter mais do que uma entrega aberta** ("643 (comando) / 349 (Paços do
  Concelho)": dois rádios consoante o local). É deliberado.
- **Há rádios com ficha mínima** — só o indicativo, sem série nem alias, com a proveniência
  em `obs` —, de números que não existiam no master.
- **As avarias da carga têm `registado_por = 'importação'`.** Fecham-se pelo ecrã como as
  outras; o valor fica só a dizer de onde vieram.
- **Os telemóveis guardam em `obs` o texto original** das quatro colunas de onde o estado foi
  lido ("ABATE 2023" onde devia estar um nome): é o que deixa conferir a classificação sem
  voltar ao Excel.

## As impressoras não seguem o molde — e é de propósito

O terceiro tipo é o primeiro que **não se entrega a ninguém**: uma impressora está instalada num
serviço. A migração `003` tem o raciocínio por extenso; o que aqui interessa é não desfazer as
decisões por parecerem esquecimentos.

- **Não há `impressoras_atribuicoes` nem `_avarias`, e não há coluna `estado`.** Não faltam: sem
  avarias o estado era 'disponivel' em todas as linhas para sempre. Por isso também **não
  existe `recalcularEstado()` no `impressoras.js`** — não procures o que ele não tem. Desde a
  `006` há **`impressoras_abates`** (vão a auto de abate), e "abatida" lê-se de lá, sem coluna.
  Se as avarias vierem a ser registadas, é migração nova, com a coluna e o recálculo.
- **A localização é uma coluna, não um histórico.** Guarda-se onde a impressora ESTÁ, não por
  onde andou — o ficheiro de origem também só tem "Localização Atual", uma célula por máquina.
  A ficha di-lo em voz alta, para ninguém procurar um histórico que não existe. Se for preciso
  saber quando mudou de sítio, entra uma `impressoras_localizacoes` no molde do `_atribuicoes`.
- ⚠️ **O `PUT /impressoras/:id` grava só os campos que vierem no corpo** — ao contrário do dos
  telemóveis, que grava a lista toda e apaga o que não vier. É o que faz "mudar de serviço",
  um pedido com um campo só, não apagar o IP, a série e o modelo. **Não uniformizes isto com o
  outro ficheiro**: o ecrã das impressoras conta com esta regra.
- **Os IP guardam-se sem os zeros à esquerda** (`10.22.129.049` → `10.22.129.49`). A folha
  escreve-os das duas maneiras; a base guarda uma só, a canónica — a que o Windows, o `ping` e
  o painel da impressora mostram. É `normalizarIP()`, no `impressoras.js`. ⚠️ **Só toca em
  IPv4 bem formados**; qualquer outra coisa no campo passa intacta.
- O IP **não tem índice único**, e não é por causa das escritas: é porque não é a identidade da
  máquina — muda quando ela muda de sala. Únicos são o `num_serie` e o `host_name`, os dois
  filtrados.
- ⚠️ **Uma linha da origem não bate certo consigo própria.** Em quinze das dezasseis o host
  acaba no último octeto do IP (`10.22.129.246` → `CML182_KO_246`); na AADIVPOL o IP diz `.60`
  e o host diz `_050`. Os dois entraram como estão. A verificação é o `hostDivergeDoIP()` do
  ecrã, que calcula a cada desenho para o aviso desaparecer sozinho quando alguém corrigir. **Não a
  gravaste numa coluna, não a graves agora**: era um valor a envelhecer.

## As máquinas fotográficas: entregas sim, estado não

O quarto tipo (`004`) escolhe do molde peça a peça, como as impressoras — mas escolhe
diferente. Vale a pena ver a tabela do README (*Acrescentar um tipo de equipamento*) antes de
assumir o que este ficheiro tem.

- **Tem `maquinas_atribuicoes`**, no molde do `telemoveis_atribuicoes`: uma máquina fotográfica
  é levantada por alguém, ao contrário de uma impressora.
- **Não tem coluna `estado`, e não é esquecimento.** Sem avarias sobrava o par
  disponível/atribuído, que se lê da existência de uma entrega aberta — a `ENTREGA_ABERTA` do
  `maquinas.js`, um `OUTER APPLY` que a listagem e o detalhe já fazem. Guardá-lo numa coluna
  era arranjar uma segunda fonte de verdade para o que já se sabe. **Por isso também não há
  `recalcularEstado()` aqui** — não procures o que não existe.
  Isto **não contradiz** a regra dos rádios ("o estado é uma coluna, não uma consulta"): lá são
  quatro valores com precedência, vindos de três tabelas. Aqui é uma pergunta a uma tabela só.
  Desde a `006` há também **`maquinas_abates`**: "abatida" é ter lá uma linha 'abatido', e a
  máquina abatida sai das disponíveis.
- ⚠️ **A data de entrega é opcional neste tipo**, ao contrário dos outros. Três dos quatro
  levantamentos da carga não têm data e não se inventa nenhuma — nem sequer há um dia de
  apuramento comum como o `DATA_ATRIBUICAO_PADRAO` dos rádios. O ecrã mostra-as a âmbar e o KPI
  "Sem data" conta-as. **Não ponhas um `|| hoje()` no `/atribuir`**: fecha-se a entrega anterior
  com a data de hoje, mas a nova entrega fica sem data se não vier nenhuma.
- **A capacidade guarda-se como `32 GB`.** A folha escreve-a de três maneiras (`32Gb`, `32GB`,
  `32 Gb`); a base guarda uma, com o **`B` maiúsculo** — `B` é *byte* e `b` é *bit*, e um cartão
  de "32 Gb" à letra tinha 4 GB — e o espaço que separa a grandeza da unidade. É a
  `normalizarCapacidade()`, no `maquinas.js`. ⚠️ **Arruma a unidade, nunca o número** —
  nem a vírgula decimal, que em português é a certa — e só toca no que reconhece: um valor que
  não seja um número seguido de KB/MB/GB/TB passa intacto.
- **O que veio da folha e fica como está**: a marca diz `Kodak W` / `Kodak R` (o W e o R
  distinguem algo que a folha não explica — parti-los era inventar o significado de uma letra)
  e a coluna "Levantou" traz o **username**, não o nome.

## Os GPS: o molde das impressoras, numa viatura

O sexto tipo (`008`) são os GPS dos reboques (Garmin e TomTom). Escolhe do molde como as
impressoras: **não se entrega a ninguém** — está numa viatura —, sem `_atribuicoes`, sem
`_avarias`, sem coluna `estado` e sem `recalcularEstado()`. Abates tem, como todo o equipamento.

- **A viatura são três colunas no próprio GPS** (`viatura_chave`, `viatura_matricula`,
  `viatura_marca`), como a `localizacao` das impressoras: onde está, não por onde andou. "Em
  viatura" é ter a chave **ou** a matrícula. Não há tabela de viaturas — o IGA não as gere.
- **O "Nº Chave" é texto** (a etiqueta da chave do reboque), mas a listagem ordena-o como
  número quando o é.
- ⚠️ **O `PUT /gps/:id` grava só os campos que vierem**, como o das impressoras: "mudar de
  viatura" manda só os três da viatura. Não o uniformizes com o dos telemóveis.
- **Um tipo novo entra no `CK_autos_abate_tipo`**, senão os autos de abate dele são recusados
  pela base — foi o que a `008` teve de fazer.

## Os tablets: o molde completo, e a ficha mostra tudo

O quinto tipo (`005`) é o molde dos telemóveis inteiro — entregas a pessoas, avarias, abates e
`estado` com o seu `recalcularEstado()` —, mas na base do `db.js`. O que muda:

- ⚠️ **O PIN e o PUK vêm no `GET /tablets/:id`, à vista, sem rota de credenciais.** Decisão de
  2026-10-20: quem gere os tablets quer tudo ao abrir a ficha. **Continuam fora do `COLUNAS`**
  — a listagem e o CSV não os levam — e **gravá-los é só de `canAdmin`**. Não "uniformizes" com
  os telemóveis em nenhum dos sentidos.
- **Foram a primeira carga depois de retirados os importadores**: entraram uma vez, por SQL
  gerado fora do repositório, e não há `tablets_importacoes`. É o caminho para uma próxima
  carga, se houver.
- ⚠️ **O ICCID não tem índice único, de propósito**: dois pares de tablets da origem partilham-no
  (39/44 e 40/67/TAB/2023), e a ficha avisa nas `obs`. Únicos são o inventário, o número, o IMEI
  e a série, todos filtrados.
- **A série guarda-se em maiúsculas** (`serie()` no `tablets.js`): as da Samsung são-no, e a
  folha tinha algumas à mão em minúsculas — a mesma série das duas maneiras passava o índice.
- **"UTILIZADOR" nas folhas não é uma pessoa**: é a `finalidade` ("Na Minha Rua Lx"). Quem tem o
  tablet é a entrega. Só 25 dos 34 têm inventário; nos outros a tabela mostra o número do cartão.

## Autos de abate: propor, auto, homologar

Desde a `006`/`007` abater não é um clique: **propõe-se** (fica `estado = 'proposto'` na
`<tipo>_abates`), junta-se num **auto de abate** e só ao **homologar** o auto é que fica
`'abatido'`. A migração `006` tem o raciocínio inteiro.

- **Cada auto é de uma categoria só**, e não por regra: o cabeçalho (`autos_abate`) tem o `tipo`,
  e as linhas vivem na `<tipo>_abates`. Não acrescentes um ecrã que junte categorias.
- **O n.º do auto é o do papel**: escreve-se na janela do auto, com o IGA a **sugerir** o
  seguinte ao maior do ano (`MAX(numero)+1`). A numeração da PM é **uma só para todas as
  categorias**: o `UX_autos_abate_numero` (ano, número) e o `numeroOcupado()` recusam o mesmo
  número noutra categoria. Num rascunho o número corrige-se; o ano é sempre o da data.
- **O `recalcularEstado()` só conta abates `'abatido'`.** Um equipamento proposto mantém o
  estado (normalmente 'avariado') e **não se entrega** — o `/atribuir` recusa-o.
- **As rotas são as mesmas em todos os tipos**, em `server/routes/iga/autos.js` (`montarAutos()`),
  chamado em cada router **antes do `/:id`**. As páginas continuam independentes: o bloco do
  ecrã está copiado nas cinco, de propósito.
- ⚠️ **O cabeçalho está na base do módulo e as linhas na base do tipo.** Nos telemóveis são
  bases diferentes em desenvolvimento: o `autos.js` lê uma e depois a outra, sem JOIN, e o
  `telemoveis_abates.auto_id` não tem FK (ver a `007`).
- ⚠️ **O PDF desenha por cima do modelo da DMSI** (`server/modelos/auto_abate_CML.pdf`), nas
  coordenadas dos campos — o modelo é XFA e não se preenche por programa. As coordenadas estão
  no `auto_pdf.js`; **se a DMSI mudar o modelo, mudam com ele**. A tabela tem 10 linhas: com
  mais, vão 9 e a 10.ª remete para o anexo, que traz a lista toda.
- **Um abate homologado não se anula** (o papel está assinado). Um abate de antes dos autos,
  sem `auto_id`, anula-se pela administração, como antes.
- ⚠️ **Os 39 "abates" dos telemóveis que vieram da carga eram propostas, não abates**
  (decisão de 2026-10-20): a folha dizia "para abate", e ainda não foram. Passaram a
  `'proposto'` — 12 continuam entregues a quem os tem — e a data que a folha trazia, nos 4
  que a tinham, ficou nas `obs` do abate. Entram no próximo auto dos telemóveis.
- **O Auto 02/2023 dos rádios foi lançado à mão** (148 rádios, do `abate rádios.pdf`), já
  homologado. Não o "corrijas" para rascunho.

## Credenciais dos telemóveis

- ⚠️ **Nenhuma consulta de listagem ou de detalhe pode devolver `pin`, `puk` ou
  `palavra_passe`.** Os SELECT do `telemoveis.js` escrevem as colunas uma a uma e **não há
  `SELECT *`** — é o que faz de acrescentar um campo à listagem uma decisão e não um descuido.
- **A conta (`utilizador`) foi essa decisão, em 2026-10-13**: sai na listagem e é uma coluna da
  tabela, porque é por ela que o NSIC identifica o aparelho. Foi tomada sabendo que a palavra
  passe se deduz da conta (`pmNNNind` → `pmNNNind!`). **Gravá-la continua a ser só de
  `canAdmin`**, e **não entra no CSV**: levá-la num ficheiro é outra decisão.
- A única porta é `GET /telemoveis/:id/credenciais`, com `exigirAdmin`, e a leitura fica no
  log. O `PUT` também só grava credenciais a quem é `canAdmin`, e só os campos que vierem no
  corpo: um formulário sem eles não pode apagá-las por omissão.
- **O PIN não se completa com zeros à esquerda**, por muito que "20" seja obviamente "0020".
  Dez tentativas erradas pedem o PUK. O ecrã avisa, o código não adivinha.

## Autorização

- O gate de VER está aplicado **ao router inteiro** (`router.use(exigirAcesso)`, logo a seguir a
  `/permissoes`). **Rotas novas vão dentro dele**; as que mudam dados levam `exigirEdicao`, e a
  remoção e a **homologação de um auto de abate** `exigirAdmin`. Propor para abate e montar o
  auto são de quem tem edição.
- **Não acrescentes autenticação.** A identidade vem do Windows (SSPI) na intranet e é injectada
  pelo harness em desenvolvimento.
- **O `npm run harness-rede` é o harness a fazer de SSPI**, para colegas testarem pela rede — não
  é autenticação nova no módulo: o router continua a ler só `req.user`. Vive todo no
  `_harness-iga.js`, e o `node-expose-sspi` é `devDependency` por isso. ⚠️ **NTLM forçado**: o
  harness corre na conta de quem o arranca, e o Kerberos falhava sem dizer porquê. ⚠️ Quem não
  está em `colaboradores` é **inscrito sozinho no grupo `IGA`** com um mecanográfico de
  900000001 para cima — andaime da base de desenvolvimento, como o `000_seed_local.sql`; nunca
  o leves para a intranet.
- Nunca leias `x-remote-user` directamente — só `req.user`.
- `canAdmin` é só do grupo `IGA-Admin`: ser administrador da consola AD-PM **não** abre o
  abate. É de propósito — senão, desactivar alguém no grupo não tinha efeito nenhum.

## Uma página por tipo de equipamento

- **`public/radios.html`, `public/telemoveis.html`, `public/impressoras.html` e
  `public/maquinas.html`, `public/tablets.html` e `public/gps.html` são independentes, e é deliberado.** Não há motor partilhado entre elas, nem separadores dentro
  de uma página: cada tipo tem o seu ecrã, e o próximo equipamento será outra página. Foi
  decidido assim com o custo à vista — **não "arrumes" isto para um ficheiro comum** por
  parecer duplicação; é uma escolha, não um descuido. Se algum dia for para mudar, é conversa
  a ter, não uma refactorização de passagem.
- **`public/iga.html` é a porta de entrada** — um cartão por equipamento, com as contagens, e
  é para lá que a raiz reencaminha. Não tem lógica de inventário nenhuma: só lê os
  `/estatisticas` de cada tipo e abre a página respectiva. O cabeçalho das outras páginas traz
  de volta a ela.
- **As páginas de equipamento NÃO têm barra de navegação entre tipos.** Estando na página dos
  rádios não se vê o botão dos telemóveis, e vice-versa — cada página é dedicada ao seu tipo.
  A navegação entre tipos é sempre pela entrada: cabeçalho → `iga.html` → outro cartão. Por
  isso **a lista de tipos vive num só sítio**, o `TIPOS` do `iga.html`; não a espalhes pelas
  páginas com um `<nav>` de atalhos — foi tirado de propósito.
- **Cada tipo traz as suas `contagens` no `TIPOS`** — de uma a quatro, que são os números do
  rodapé do cartão. Os rádios e os telemóveis partilham a `CONTAGENS_PARQUE` (entregues,
  disponíveis, avariados, abatidos); as impressoras contam o sítio; as máquinas fotográficas
  trazem **três** e a grelha ajusta-se. Não voltes a fixar os quatro rótulos no `cartao()` —
  era o que fazia o cartão das impressoras dizer "abatidos —" para sempre —, nem inventes um
  quarto número para encher a linha.
- ⚠️ **As classes da grelha estão escritas por extenso no `GRELHA_CONTAGENS`**, e não montadas
  com `grid-cols-${n}`. O Tailwind compila as classes que **encontra no ficheiro**: uma classe
  construída em execução não existe para ele, e a grelha sai sem colunas nenhumas.
- Os cartões da entrada **toleram uma API em baixo**: cada tipo é lido por si, e o que falha
  aparece com o aviso em vez de levar a página atrás. A base dos telemóveis é outra e pode
  estar em baixo sozinha.
- O que **é** partilhado, e continua a sê-lo: o servidor (`server/routes/iga/`, um router
  por tipo montado no `index.js`), as permissões, e os assets em `public/iga/`.
- O passo a passo para juntar um tipo novo está no README, secção *Acrescentar um tipo de
  equipamento*.

## Ao mexer no código

- **Não há build.** Cada página é HTML, CSS e JavaScript num ficheiro só, servido
  directamente: guardar e recarregar chega.
- Alterações em `server/routes/iga/` obrigam a **reiniciar o harness**. O
  `permissoes.js` tem uma cache de 10 minutos por utilizador: depois de mexer em
  `colaboradores` ou nos grupos, reiniciar é a única forma de ver o efeito.
- ⚠️ **A ordem das rotas nos ficheiros é significativa.** O Express serve a primeira que casa e
  o `/:id` apanha qualquer palavra, portanto rotas de nome fixo (`/sistema`, `/conferencia`,
  `/utilizadores`, `/estatisticas`) vão **acima** do `/:id`. Restringir o parâmetro com
  `/:id(\d+)` **não funciona** nesta versão do Express (4.22): a rota deixa de casar de todo e
  o pedido morre num "Cannot GET". Já foi tentado; o detalhe do rádio dava 404.
- O Tailwind e o lucide são **ficheiros locais** em `public/iga/`, não vêm de CDN.
- **O `.env` nunca entra no git.** Variáveis novas documentam-se no `.env.example`, sem valores.

## Convenções

- **Código e comentários em português.** Os nomes de domínio ficam como estão: `indicativo`,
  `matricula`, `guia`, `abate`, `alias`, `talkgroup`.
- Mantém o estilo dos ficheiros à volta — os comentários explicam **porquê**, não o quê.
- Alterações cirúrgicas: mexe no que é preciso e não aproveites a boleia para reorganizar o resto.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
