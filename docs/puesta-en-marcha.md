# Puesta en marcha

Esta guía sirve para dos momentos: dejar el CRM listo para un cliente
nuevo y comprobar que quedó bien antes de entregarlo.

Cada paso nombra la pantalla exacta. Si una pantalla no aparece donde
dice, no sigas: falta una migración o falta un rol de administrador.

Una instalación atiende **un negocio**. El modo multiempresa, los planes
y la facturación no existen en este código y no están en el alcance de
esta guía: si el cliente necesita dos negocios separados, se levantan
dos instalaciones con dos proyectos de Supabase.

---

## 1. Antes de empezar

### Lo que tiene que traer el cliente

- Un número de teléfono conectado a la **API de WhatsApp Business de
  Meta** (no sirve WhatsApp Business normal ni el número personal).
- El **ID del número de teléfono** y el **ID de la cuenta de WhatsApp
  Business (WABA)**.
- Un **token de acceso permanente** de la app de Meta (no uno temporal
  de 24 horas).
- El **App Secret** de esa misma app de Meta.
- El **PIN de verificación en dos pasos** del número, si es un número en
  producción. Los números de prueba de Meta no tienen PIN.
- Una **clave de OpenAI o de Anthropic a su nombre**. El asistente es
  «trae tu propia clave»: el cliente paga su consumo directo al
  proveedor y nosotros nunca guardamos una clave global.

### Lo que tienes que tener tú

- Un proyecto de **Supabase** (URL, clave anónima y clave de servicio).
- Un **dominio con HTTPS** apuntando al despliegue. Meta no acepta
  `http` para el webhook.
- Un **programador de tareas externo** que pueda llamar una URL cada
  pocos minutos (cron del servidor, hPanel de Hostinger, Vercel Cron).
  Ver la sección 3: sin esto, la mitad del producto no funciona.

### Variables de entorno

Copia `.env.local.example` y complétalo. Las que importan para una
puesta en marcha nueva:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | sí | Proyecto de Supabase. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sí | Cliente del navegador. |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | Webhook, crons y motor de IA. Nunca en código de cliente. |
| `ENCRYPTION_KEY` | sí | 64 caracteres hex. Cifra el token de WhatsApp y la clave de IA. Si la rotas, hay que volver a guardar ambas. |
| `META_APP_SECRET` | sí | Verifica la firma de cada webhook entrante. Sin ella el webhook rechaza todo. |
| `NEXT_PUBLIC_SITE_URL` | recomendada | URL canónica del despliegue, sin barra final. |
| `NEXT_PUBLIC_APP_LOCALE` | recomendada | `es` en producción. |
| `AUTOMATION_CRON_SECRET` | sí en la práctica | Secreto compartido de las tres rutas de cron. Genera uno con `openssl rand -hex 32`. |
| `META_APP_ID` | opcional | Solo para crear y enviar a aprobación plantillas con encabezado de imagen desde el CRM. Enviar una plantilla ya aprobada no la necesita. |
| `AI_REQUEST_TIMEOUT_MS` | opcional | Tope por llamada al proveedor. Por defecto 30000. |
| `AI_CONTEXT_MESSAGE_LIMIT` | opcional | Mensajes recientes que ve el modelo. Por defecto 20. |

No hay variable de entorno para la clave de IA: se pega en la pantalla
del asistente y se guarda cifrada.

### Base de datos

Aplica **todos** los archivos de `supabase/migrations/` en orden de
nombre, desde `001` hasta la última. Se hace desde el SQL Editor de
Supabase o con `supabase db push`. Todas son idempotentes: volver a
correr una no rompe nada.

Las de este producto son las que habilitan lo que sigue:

- `040` — zona horaria y terminología del negocio, estado de la
  conversación (`ai_active`, `waiting_for_human`, `human_active`,
  `closed`).
- `041` — perfiles de asesor, horarios semanales, tareas, política de
  asignación.
- `042` — persona del asistente, conocimiento por tipo, catálogo,
  etiquetas de lead, lectura de la conversación.
- `043` — columnas de lead en las oportunidades, etapas de ganado y
  perdido, cierre automático por etapa.
- `044` — el RPC de métricas que alimenta el panel del día.

Comprueba que corrieron: en Supabase, la tabla `catalog_items` y la
función `account_operations_metrics()` deben existir.

---

## 2. Configuración inicial, en orden

El orden importa: cada paso usa lo del anterior. Todo lo de esta
sección lo hace un usuario con rol **Propietario** o **Administrador**.

### 2.1. Crea la cuenta y suma al equipo

1. Entra al despliegue y regístrate. Ese primer usuario es el
   propietario de la cuenta.
2. **Configuración → Miembros del equipo** (`/settings?tab=members`) →
   *Invitar a un miembro del equipo*.
3. Elige el rol: Administrador (configura todo), Agente (atiende, sin
   configuración) u Observador (solo lectura).
4. Copia el enlace y mándalo. El enlace se muestra una sola vez.

Solo Propietario, Administrador y Agente reciben asignaciones
automáticas.

### 2.2. Conecta WhatsApp

**Configuración → WhatsApp** (`/settings?tab=whatsapp`).

1. Pega **ID del número de teléfono**, **ID de la cuenta de WhatsApp
   Business** y **Token de acceso permanente**.
2. Inventa un **Token de verificación del webhook** (cualquier cadena
   larga) y guárdalo también en Meta.
3. Pega el **PIN de verificación en dos pasos** si el número es de
   producción. En blanco para números de prueba.
4. Copia la **URL de callback del webhook** que muestra la pantalla y
   pégala en el panel de apps de Meta, con el mismo token de
   verificación. Suscribe el campo `messages`.
5. *Guardar configuración* → *Probar conexión con la API*. Debe decir
   **Credenciales válidas** y **Registrado — Meta enviará los eventos**.
6. Deja activo **Conservar adjuntos entrantes**. Meta borra las fotos,
   videos y notas de voz recibidas a los ~30 días; con esto se copian a
   tu almacenamiento de Supabase.

### 2.3. Zona horaria del negocio

**Configuración → Miembros del equipo → Horarios y asignación →
Reparto de conversaciones → Zona horaria del negocio**.

Elígela antes que nada: los turnos, el «hoy» del panel, el corte del mes
y la hora de los recordatorios se calculan en esta zona, nunca en la del
servidor ni en la del navegador de quien mira. El valor por defecto es
`UTC`.

### 2.4. Terminología

**Configuración → Terminología** (`/settings?tab=terminology`).

Cambia las palabras del CRM por las del negocio. Solo cambia lo que se
ve; ningún dato se mueve y las claves internas siguen iguales.

Los nueve conceptos: Cliente ganado, Cliente perdido, Lead, Leads
(plural), Oportunidad, Asesor, Asesores (plural), Embudo, Producto o
servicio.

Ejemplos: una academia pone «Matriculado» en *Cliente ganado* y «Curso»
en *Producto o servicio*; una inmobiliaria pone «Contrato firmado» y
«Departamento»; una clínica pone «Paciente» y «Tratamiento». Lo que
dejes en blanco se muestra con la palabra traducida por defecto.

### 2.5. Equipo y turnos

**Configuración → Miembros del equipo → Horarios y asignación**.

Para cada persona, *Editar perfil de asesor*:

- **Departamento** — texto libre (Ventas, Soporte, Admisiones).
- **Especialidades** — separadas por comas. Es lo que permite mandarle
  un lead concreto («niños», «empresas», «alquiler»).
- **Capacidad** — cuántas conversaciones puede llevar a la vez.
- **Recibe asignaciones automáticas** — apágalo para quien no atiende.
- **Horario semanal** — *Agregar franja*, un día y un rango por franja
  (una persona con mañana y tarde lleva dos franjas ese día).

**Estar en turno no alcanza: hay que estar en línea.** Alguien figura
como *Disponible* solo si además tiene el CRM abierto; el latido de
presencia caduca a los 3 minutos. Pasado ese rato su fila dice **Sin
conexión** aunque esté dentro de su franja, y el reparto automático lo
descarta igual que a quien está fuera de turno: sea cual sea la
estrategia, primero se filtra por disponibilidad. Para cubrir un turno
sin tener el CRM abierto, esa persona pone su estado manual en
**Disponible**, que reemplaza al horario y al latido.

Sin horario cargado, la persona se considera en turno siempre; la
conexión se le sigue exigiendo. Es lo correcto para un equipo chico;
para turnos de verdad, carga las franjas.

Cada quien puede forzar su estado desde **Mi trabajo → Mi
disponibilidad** (Según mi horario, Disponible, Ocupado, No disponible).
El estado manual gana sobre el horario hasta que lo devuelvan a «Según
mi horario».

### 2.6. Política de asignación

Misma tarjeta: **Reparto de conversaciones**.

- **Estrategia** — Según horario y carga (el valor sensato por
  defecto), Por turnos, Menor carga, Por departamento, Por especialidad,
  Por producto o servicio, Asesor anterior, Por prioridad, o Manual.
- **Si nadie está disponible** — *Dejar en cola hasta el siguiente
  turno* (la tarea espera y el cron la asigna al abrir el turno) o *La
  IA sigue atendiendo y recopila datos*.

«Por producto o servicio» necesita que cada asesor tenga ítems del
catálogo vinculados. Hoy eso solo se puede cargar por API
(`PUT /api/account/advisors/<userId>` con `item_ids`); no hay campo en
pantalla. Si no vas a hacerlo, usa «Por especialidad».

### 2.7. Catálogo

**Configuración → Catálogo** (`/settings?tab=catalog`).

1. Primero los **Atributos del negocio**: los campos propios del rubro
   (nivel, modalidad, dormitorios, distrito, duración). Tipo texto,
   número, sí/no o lista de opciones.
2. Después *Nuevo ítem* por cada producto o servicio: Nombre,
   Categoría, Descripción, Precio, Moneda, **Disponibilidad**
   (Disponible / Pocos cupos o unidades / No disponible / A pedido),
   Stock, Características y los atributos que definiste.

Esto es lo único que el asistente puede citar como precio o
disponibilidad. Lo que no esté cargado, no lo dice. Un ítem archivado
deja de ofrecerse.

### 2.8. Conocimiento del negocio, por tipo

**Agentes de IA** (`/agents`) **→ pestaña Setup → Base de conocimiento
→ Agregar documento**.

Cada documento lleva un **Tipo**: Descripción del negocio, Pregunta
frecuente, Política, Horarios, Ubicación, Métodos de pago, Garantías,
Entregas y envíos, Requisitos, Promoción, Documento.

El tipo no es decorativo: **Descripción del negocio, Horarios, Ubicación
y Métodos de pago se incluyen en todas las respuestas**; el resto se
recupera solo cuando la pregunta lo amerita. Carga esos cuatro sí o sí.

Un documento por idea. Diez fichas cortas funcionan mejor que un
documento largo.

### 2.9. Etiquetas de lead

**Configuración → Etiquetas de lead** (`/settings?tab=labels`).

Vienen cinco integradas: Posible lead, Cliente interesado, Lead nuevo,
Pago pendiente, Cliente que ya pagó.

- Renómbralas con las palabras del negocio. La **clave interna** no
  cambia, así que nada se rompe ni se pierde.
- El campo **Cuándo aplica** lo lee la IA para decidir. Escríbelo en
  una línea y en concreto.
- Las integradas no se eliminan; las que agregues tú, sí.

Solo las integradas *Cliente interesado*, *Lead nuevo*, *Pago pendiente*
y *Cliente que ya pagó* abren un lead en el embudo. *Posible lead* y las
etiquetas propias no lo hacen por sí solas.

### 2.10. Embudo y etapas de cierre

**Pipelines** (`/pipelines`).

La primera vez que entras se crea un embudo con cinco etapas en inglés.
Entra a *Administrar pipeline* y:

1. Renombra las etapas con las palabras del negocio.
2. Comprueba que la etapa final ya está marcada como **Etapa de ganado**:
   el embudo se siembra así. Crea la etapa de perdido y márcala como
   **Etapa de perdido**: por defecto no existe.

Las oportunidades que caen en una etapa marcada se cierran solas y se
les estampa la fecha de cierre; si las sacas de ahí, se reabren. Sin
esto, el panel no puede contar conversiones.

Hazlo antes de encender el asistente: si no existe un embudo, los leads
que la IA detecte no se abren en ningún lado.

### 2.11. El asistente de IA

**Agentes de IA → pestaña Setup**.

1. **Proveedor y clave**: elige OpenAI o Anthropic, pega la clave del
   cliente, deja el modelo por defecto y pulsa *Probar clave*. La clave
   se guarda cifrada y no se vuelve a mostrar.
2. **Clave de embeddings** (opcional): habilita la búsqueda semántica en
   el conocimiento. Puede ser la misma clave. Sin ella se busca por
   palabras clave, que para un negocio chico alcanza.
3. **Cómo habla el asistente**: nombre, rol, idioma, región, trato
   (tú/usted), tono, largo de las respuestas, emojis, estilo, objetivo
   principal e instrucciones especiales. Nadie escribe un prompt: estas
   opciones se convierten solas en las instrucciones del modelo.
4. **Contexto del negocio e instrucciones**: déjalo corto o vacío. El
   catálogo y el conocimiento hacen ese trabajo mejor.
5. Enciende **Habilitar el asistente de IA** y **Respuesta automática a
   mensajes entrantes**.
6. **Máximo de respuestas automáticas por conversación**: tres o cuatro
   es un buen arranque. Al llegar al tope, el bot se calla y pasa el
   chat a una persona.
7. **Derivar a**: una persona concreta, o la cola sin asignar para que
   la tome quien esté de turno.

La pestaña **Playground** sirve para probar el tono y el conocimiento
sin tocar WhatsApp. **No consulta el catálogo ni aplica la persona ni la
memoria del contacto**: eso solo corre en la respuesta automática a un
mensaje real. Las pruebas de precio, persona y memoria van por WhatsApp.

### 2.12. Plantillas de WhatsApp

**Configuración → Plantillas** (`/settings?tab=templates`).

Fuera de la ventana de 24 horas, WhatsApp solo deja retomar el contacto
con una plantilla aprobada por Meta. Deja al menos dos creadas y
aprobadas antes de entregar: una de reenganche («¿seguimos con lo que
conversamos?») y una de recordatorio de cita o pago.

La aprobación la da Meta y demora. No lo dejes para el día de la
entrega.

---

## 3. El cron externo

Nada dentro de la app corre solo. Tres rutas hacen trabajo por tiempo y
cada una actúa únicamente cuando algo externo la llama.

| Ruta | Qué hace | Cada cuánto |
|---|---|---|
| `GET /api/tasks/cron` | Reintenta la asignación de cada tarea que sigue esperando persona (el lead de las 13:00 se asigna cuando entra el turno de las 15:00) y manda un aviso por cada tarea vencida. | 1–5 min |
| `GET /api/automations/cron` | Reanuda los pasos **Esperar** de las automatizaciones. | 1–5 min |
| `GET /api/flows/cron` | Limpia ejecuciones de flujos abandonadas. | 5 min |

Las tres leen el mismo secreto, `AUTOMATION_CRON_SECRET`, y lo esperan
en la cabecera **`x-cron-secret`**.

Ejemplo de crontab en un VPS (`crontab -e`):

```
CRON_SECRET=<el mismo valor que AUTOMATION_CRON_SECRET>
*/2 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.tucliente.com/api/tasks/cron >/dev/null
*/2 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.tucliente.com/api/automations/cron >/dev/null
*/5 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://crm.tucliente.com/api/flows/cron >/dev/null
```

La primera línea no es opcional: el crontab no hereda las variables de
tu sesión, así que sin ella los tres `curl` mandan la cabecera vacía y
reciben **401**.

En Hostinger es **hPanel → Avanzado → Cron Jobs**, un trabajo por línea:
ahí no hay dónde declarar la variable, así que escribe el secreto
literal dentro de cada comando.

**Sin este cron, las tareas no se asignan al empezar el turno.** Una
conversación que llegó fuera de horario, o que pedía a alguien que no
estaba disponible, se queda en «Sin asignar» para siempre: nadie recibe
notificación y el equipo se entera cuando el cliente se cansa de
esperar. Los recordatorios vencidos tampoco avisan.

Comprueba a mano después de configurarlo:

```
curl -H "x-cron-secret: <secreto>" https://crm.tucliente.com/api/tasks/cron
```

Debe responder `{"retried":0,"assigned":0,"reminded":0}` o números
mayores. Un **503** significa que falta la variable en el servidor; un
**401**, que el secreto de la cabecera no coincide.

---

## 4. Cómo se comprueba que quedó bien

Diez escenarios. Cada uno se hace de principio a fin, con el cron ya
corriendo y con un teléfono de prueba que no sea el número del negocio.

### 4.1. Horarios y disponibilidad

1. **Configuración → Miembros del equipo → Horarios y asignación →
   Editar perfil de asesor** en un agente.
2. Agrega una franja hoy de 15:00 a 17:00 y guarda.
3. Mira la fila del asesor fuera de esa franja.

**Esperado:** dice **Fuera de turno** y **Próximo turno: 15:00**. Dentro
de la franja, y con esa persona con el CRM abierto, dice **Disponible**
con su carga actual; si no tiene sesión abierta dice **Sin conexión**
aunque esté en turno (ver 2.5). El cálculo usa la zona horaria del
negocio, no la del navegador: cambia la hora de tu computadora y el
estado no se mueve.

4. Con ese usuario, entra a **Mi trabajo → Mi disponibilidad** y pon
   *Ocupado*.

**Esperado:** su fila pasa a **Ocupado** y deja de recibir asignaciones
aunque esté en turno. Al volver a *Según mi horario*, vuelve a
**Disponible**.

### 4.2. El lead de las 13:00 que pide al especialista de las 15:00

Prepara: un asesor con la especialidad «empresas» y una franja de 15:00
a 17:00; estrategia **Por especialidad**; si nadie está disponible,
**Dejar en cola hasta el siguiente turno**. A las 15:00 ese asesor tiene
que tener el CRM abierto, o su estado manual en **Disponible**: el
reparto descarta a quien no está conectado (ver 2.5).

1. A las 13:00 hora del negocio, escribe desde el teléfono de prueba
   preguntando por algo de esa especialidad y pide hablar con una
   persona.

**Esperado ahora:** la conversación queda **Esperando a una persona**.
En **Mi trabajo → Sin asignar** aparece la tarea con la nota *«Un asesor
estará disponible desde las 15:00»*. Nadie recibe notificación todavía.

2. Espera a las 15:00 (o adelanta la franja para probar en el momento).

**Esperado a los dos minutos como mucho:** con el especialista
conectado, la tarea aparece en **Mis pendientes** y le llega la
notificación. Si llamas el cron a mano, responde
`{"retried":1,"assigned":1,...}`. Si a esa hora no tiene el CRM abierto,
la tarea sigue en la cola y el cron devuelve
`{"retried":1,"assigned":0,...}` en cada pasada hasta que abra el CRM o
ponga su estado manual en Disponible.

Si sigue sin asignarse, ve a 5.2.

### 4.3. La IA responde con precio y disponibilidad reales, y no inventa

Prepara: al menos un ítem en el catálogo con precio y disponibilidad, y
el asistente encendido con respuesta automática.

1. Desde el teléfono de prueba, pregunta el precio de ese ítem con las
   palabras del cliente («cuánto sale el curso de inglés para niños»).

**Esperado:** responde con el **precio exacto y la moneda del catálogo**
y con la disponibilidad cargada. No aparece un precio distinto ni
aproximado.

2. Pregunta por algo que no está en el catálogo.

**Esperado:** no inventa. Dice que lo consulta o deriva a una persona, y
en la **Bandeja de entrada → barra lateral → Lectura de la IA** queda
registrada la intención y, si corresponde, «Necesita una persona».

3. Archiva el ítem y vuelve a preguntar.

**Esperado:** deja de ofrecerlo.

Esto solo se prueba por WhatsApp. El Playground no consulta el catálogo.

### 4.4. La persona del asistente, sin escribir prompts

1. **Agentes de IA → Setup → Cómo habla el asistente**: nombre
   «Valeria», rol «asesora», trato **Usted**, respuestas **Cortas**,
   emojis apagados. Guarda.
2. Escribe desde el teléfono de prueba.

**Esperado:** se presenta como Valeria, trata de usted, responde en una
a tres frases y sin emojis. Nadie escribió una sola instrucción técnica.

3. Cambia el trato a **Tú** y los emojis a encendido, guarda y vuelve a
   escribir desde otra conversación.

**Esperado:** el cambio se nota en la siguiente respuesta.

### 4.5. El conocimiento tipado

1. Carga un documento con **Tipo = Horarios** («Atendemos de lunes a
   viernes de 9 a 19 y sábados de 9 a 13») y otro con **Tipo = Pregunta
   frecuente** sobre algo puntual (por ejemplo la política de
   devoluciones o los requisitos de matrícula).
2. Pregunta por WhatsApp «¿hasta qué hora atienden?».

**Esperado:** responde con el horario aunque no exista un documento
titulado con esa palabra: los tipos Descripción, Horarios, Ubicación y
Métodos de pago entran en todas las respuestas.

3. Pregunta lo de la ficha de pregunta frecuente.

**Esperado:** responde con el contenido de esa ficha, recuperado por
relevancia.

### 4.6. Renombrar una etiqueta

1. **Configuración → Etiquetas de lead**: renombra *Cliente que ya
   pagó* a la palabra del negocio («Matriculado», «Paciente activo»,
   «Contrato firmado»). Guarda.
2. Abre una conversación ya clasificada con esa etiqueta.

**Esperado:** en **Lectura de la IA → Etiqueta** aparece el nombre
nuevo. La clave interna sigue siendo la misma, así que los leads que ya
estaban clasificados **no se pierden** y siguen contando en el panel,
en **Operación del día → Leads → Por etiqueta**.

3. Intenta eliminar una etiqueta integrada.

**Esperado:** no se puede; solo se renombra. Las etiquetas que creaste
tú sí se eliminan.

### 4.7. Etapas de cierre y conversiones con la palabra del negocio

1. **Pipelines → Administrar pipeline**: comprueba que la etapa final ya
   está marcada como **Etapa de ganado** y crea una etapa «Perdido»
   marcada como **Etapa de perdido**. Guarda.
2. Arrastra una oportunidad de prueba a la etapa de ganado.

**Esperado:** se cierra sola, queda como ganada y se le graba la fecha
de cierre. No hace falta tocar ningún otro botón.

3. **Configuración → Terminología**: cambia *Cliente ganado* por la
   palabra del negocio («Matriculado»). Guarda y recarga.
4. Ve al **Panel** (`/dashboard`) → **Operación del día**.

**Esperado:** la tarjeta ya no dice «Ganado este mes»: dice
**«Matriculado este mes»** y cuenta esa oportunidad. El corte del mes se calcula en la zona
horaria del negocio, así que dos personas en husos distintos ven el
mismo número.

5. Saca la oportunidad de la etapa de ganado.

**Esperado:** se reabre y deja de contar.

### 4.8. La memoria de un contacto que vuelve

1. Elige un contacto que ya tuvo una conversación leída por la IA (su
   barra lateral muestra **Lectura de la IA** con resumen y etiqueta).
2. Que escriba de nuevo días después, sin repetir el contexto: «hola,
   quería retomar lo que conversamos».

**Esperado:** la respuesta reconoce lo anterior — el producto o servicio
que le interesaba, el próximo paso pendiente, su asesor si tenía uno —
sin que el cliente lo repita. El resumen de la barra lateral se
actualiza con lo nuevo.

3. Repite con un contacto nuevo, sin historial.

**Esperado:** no inventa un pasado. Arranca de cero y pregunta.

### 4.9. El seguimiento escrito en una línea

1. **Mi trabajo → Recordatorio**: escribe `recuérdame mañana llamar a
   Juan` y pulsa *Recordar*.

**Esperado:** aparece el aviso «Te lo recuerdo el …» y una tarea de tipo
**Seguimiento** en **Mis pendientes**, con vencimiento mañana a las
09:00 hora del negocio y el título «llamar a Juan». Si existe un único
contacto llamado Juan, la tarea queda enlazada a él y, si ese contacto
tiene un lead abierto, la fecha de seguimiento se estampa también ahí;
si hay dos Juanes, la tarea se crea igual pero sin enlazar (no
adivina).

2. Prueba variantes: `el lunes a las 3 llamar a la señora Rojas`,
   `en 2 horas revisar el pago`, `pasado mañana enviar la cotización`.

**Esperado:** entiende la fecha y la hora, y el título queda limpio, sin
las palabras de tiempo.

3. Escribe algo sin fecha: `llamar a Juan`.

**Esperado:** «No entendí cuándo. Prueba: "mañana a las 10", "el
lunes", "en 2 horas"». No crea nada.

4. Deja vencer un recordatorio con el cron corriendo.

**Esperado:** llega una notificación al responsable, **una sola vez**.

5. Lo mismo desde la **Bandeja de entrada → barra lateral del contacto →
   Recordatorio**, que además ya sabe de qué contacto se trata.

### 4.10. Regresión de Meta: texto y nota de voz

Este es el examen final. Si algo de aquí falla, no se entrega.

1. **Configuración → WhatsApp → Probar conexión con la API**.
   **Esperado:** *Credenciales válidas* y *Registrado — Meta enviará los
   eventos*.
2. Desde el teléfono de prueba, manda un **texto** al número del
   negocio.
   **Esperado:** aparece en la **Bandeja de entrada** en segundos, con el
   contacto creado.
3. Responde con **texto** desde el CRM.
   **Esperado:** llega al teléfono.
4. Manda una **nota de voz** desde el teléfono.
   **Esperado:** aparece en la conversación y se reproduce desde el CRM.
   Con *Conservar adjuntos entrantes* activo, queda copiada en tu
   almacenamiento y se sigue escuchando pasados los 30 días.
5. Graba una **nota de voz** desde el CRM: botón de adjuntar → *Nota de
   voz* → *Detener y adjuntar* → *Enviar*.
   **Esperado:** llega al teléfono y se escucha.
6. Manda también una foto y un documento en ambos sentidos.
7. Con una conversación de más de 24 horas sin respuesta del cliente,
   intenta escribir.
   **Esperado:** el compositor avisa que la sesión expiró y pide usar una
   plantilla. Envía una plantilla aprobada y comprueba que llega.

---

## 5. Problemas frecuentes y cómo se ven

### 5.1. El asistente no responde

| Causa | Cómo se ve | Qué hacer |
|---|---|---|
| No hay clave del proveedor, o no se puede descifrar | En *Agentes de IA → Setup* no dice que esté configurado; el Playground responde «No agent configured yet» | Vuelve a pegar la clave y pulsa *Probar clave*. Si rotaste `ENCRYPTION_KEY`, hay que volver a guardar la clave y el token de WhatsApp. |
| El interruptor principal o la respuesta automática están apagados | La IA no contesta ninguna conversación nueva | Enciende *Habilitar el asistente de IA* y *Respuesta automática a mensajes entrantes*. |
| Se alcanzó el tope por conversación | Contestó dos o tres veces y se calló en ese chat; en otros chats sí responde | Es el comportamiento esperado. Sube *Máximo de respuestas automáticas por conversación* o atiende tú ese hilo. |
| La conversación está en `human_active` | Banner **«El asistente de IA está en pausa aquí»** | Alguien pulsó *Tomar el control*. Usa *Reanudar la IA* en esa conversación. |
| La conversación tiene un agente asignado | Igual que la anterior, sin banner | La IA no pisa a una persona. Quita la asignación si quieres que vuelva a responder. |
| Hay una automatización de mensaje activa | La IA calla en todas las conversaciones, pero llegan respuestas automáticas de otro tipo | Con una automatización de *nuevo mensaje recibido* o *coincidencia de palabra clave* activa, el asistente se aparta para no responder dos veces. Desactívala o quédate con ella. |
| Tope de ritmo por cuenta | Silencios en ráfagas de muchos mensajes a la vez | Es una protección del gasto. Se normaliza solo. |

### 5.2. Las tareas se quedan sin asignar

| Causa | Cómo se ve | Qué hacer |
|---|---|---|
| No hay cron, o está mal configurado | En **Mi trabajo → Sin asignar** se acumulan tareas viejas y nadie recibe notificaciones | Llama `GET /api/tasks/cron` a mano. **503** = falta `AUTOMATION_CRON_SECRET` en el servidor. **401** = el secreto de la cabecera `x-cron-secret` no coincide. Si responde números, el problema es el programador de tareas. |
| Nadie está en turno | La tarea dice *«Un asesor estará disponible desde …»* | Correcto: se asignará sola al abrir ese turno. Si la hora es hoy y ya pasó, revisa la zona horaria del negocio. |
| Nadie tiene el CRM abierto | Las filas de **Horarios y asignación** dicen *Sin conexión* aunque estén en turno; la tarea nunca sale de *Sin asignar* | El reparto exige un latido de presencia de menos de 3 minutos. Que la persona abra el CRM, o que ponga su estado manual en *Disponible* desde **Mi trabajo → Mi disponibilidad**. |
| Nadie cumple la condición | La tarea no dice ninguna hora y nunca se asigna | Con estrategia *Por especialidad* o *Por departamento*, nadie tiene esa especialidad o ese departamento. Corrige el perfil del asesor o cambia la estrategia a *Según horario y carga*. Descarta antes la fila anterior: sin conexión el síntoma es idéntico y cambiar la estrategia no arregla nada. |
| El asesor no acepta asignaciones o está al tope | Su fila dice *No recibe asignaciones* o *Sin capacidad* | Enciende *Recibe asignaciones automáticas* o sube su capacidad. |
| Estado manual en *Ocupado* / *No disponible* | Su fila lo dice, aunque esté en turno | Que vuelva a *Según mi horario* desde **Mi trabajo → Mi disponibilidad**. |
| Estrategia **Manual** | Todo cae en la cola a propósito | Es lo configurado. Cámbiala si no era la intención. |

### 5.3. El webhook devuelve 401

Meta muestra entregas fallidas y **no entra ningún mensaje** al CRM,
aunque el número esté bien conectado y las credenciales digan
«válidas».

El 401 es la firma: `META_APP_SECRET` no es el secreto de la **misma**
app de Meta que envía el webhook. Pasa al copiar el secreto de otra app,
al regenerarlo en Meta sin actualizar la variable, o al no reiniciar el
despliegue después de cambiarla.

1. Meta for Developers → tu app → **Configuración → Básica → Clave
   secreta de la app**.
2. Pégala en `META_APP_SECRET` y **reinicia el despliegue**.
3. Manda un mensaje de prueba y confirma que entra.

No lo confundas con estos dos:

- **403 en la verificación del webhook**: no coincide el *Token de
  verificación del webhook*. Es el que inventaste tú y va idéntico en
  **Configuración → WhatsApp** y en el panel de Meta.
- **Credenciales válidas pero «No registrado»**: falta el PIN de
  verificación en dos pasos. Cárgalo en **Configuración → WhatsApp**,
  guarda y usa *Verificar con Meta*. Sin registro, Meta manda los
  eventos a la última app que reclamó el número.
