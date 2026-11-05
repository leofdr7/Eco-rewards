# Eco-Rewards · simulación de la Jetson Orin Nano Super

`first_contact.py` reconoce a la persona con la webcam y **arma la máquina** en Supabase
(`source = 'face'`). La ESP32 ya consulta `poll-session`, así que acredita los puntos
en la app web sin cambiar el firmware.

El modelo es InsightFace `buffalo_l` (un vector de 512 números, nunca una foto).
En esta PC se carga en la **VRAM** de la tarjeta con `CUDAExecutionProvider`.
En una Jetson Orin Nano Super el archivo no cambia: el mismo provider usa la memoria unificada.

```
App web ──fotos temporales──► Supabase face-inbox
                                  │
PC (RTX) o Jetson ──first_contact.py, buffalo_l en CUDA──► face_embeddings
        │
        └── sesión source=face ──► Supabase ◄──poll-session── ESP32
                                        ▲
                     eco-rewards-web.vercel.app muestra los puntos
```

## Disparadores

Los dos terminan igual: tres cuadros seguidos por encima de `UMBRAL` abren la sesión.

| Dónde | Qué hace |
|---|---|
| Tecla **Espacio** en la ventana | Igual que un botón en la máquina: identifica a cualquiera registrado |
| **Activar con mi rostro** en la app | Verifica a la persona que inició sesión, en la máquina `ECO-48FM6V` |

Sin ese disparador la cámara no abre sesión. `T` termina la sesión. `Q` o `ESC` salen.

## 1. Esta PC (RTX 4060, simulación)

Hace falta Python 3.12 (el 3.14 del sistema no tiene ruedas de ONNX Runtime) y la GPU NVIDIA.

```bash
cd face_terminal
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install onnxruntime-gpu
uv pip install -r requirements.txt
cp .env.example .env
```

En `.env`:

- `SUPABASE_SERVICE_ROLE_KEY`: Supabase → Project Settings → API Keys → **service_role**. Solo vive aquí. No va a la app ni a GitHub.
- `MACHINE_CODE=ECO-48FM6V`
- `CAMARA=0` para la cámara integrada (`/dev/video0`)

Antes de correr el script, pega [`supabase/migrations/007_insightface_faces.sql`](../supabase/migrations/007_insightface_faces.sql)
en el SQL Editor del proyecto `ocarmdddmhtrrnlmupge`. Crea los vectores de 512,
los trabajos de registro, las peticiones de la app y el bucket privado `face-inbox`.

Comprueba que el modelo entró a la VRAM (no abre la cámara):

```bash
python first_contact.py gpu
```

Tiene que imprimir `CUDAExecutionProvider` y una línea de `nvidia-smi` con la memoria usada.
Si ese provider no aparece, el programa se detiene: esta demo no sigue en CPU.

```bash
python first_contact.py reconocer
```

La ventana dice `FPS` y `GPU`. El modelo se carga **una vez** y se queda en la VRAM
mientras el proceso vive. Cada pocos segundos lee `face_embeddings` y, si la app subió
fotos, las convierte en vectores y las borra.

## 2. La misma orden en la Jetson Orin Nano Super

JetPack 6 (Ubuntu 22.04, Python 3.10). La placa no tiene VRAM aparte: CUDA usa los 8 GB
unificados. El modo Super es el de máximo rendimiento.

```bash
cat /etc/nv_tegra_release
sudo nvpmodel -m 0
sudo jetson_clocks

sudo apt update
sudo apt install -y python3-venv python3-dev python3-pip build-essential cmake v4l-utils

cd face_terminal
python3 -m venv venv
source venv/bin/activate
pip install -U pip wheel
pip install onnxruntime-gpu --index-url https://pypi.jetson-ai-lab.io/jp6/cu126
pip install -r requirements.txt
```

Copia el mismo `.env`. Si la Jetson va justa de memoria, pon `DET_SIZE=320`.

`python first_contact.py gpu` debe mostrar otra vez `CUDAExecutionProvider`.
A partir de ahí, `python first_contact.py reconocer` es el mismo programa que en la PC.

## 3. Registro desde la app web

1. En Perfil, **Registrar rostro**. Hay que aceptar el texto: solo se conserva el vector.
2. La cámara toma 5 fotos y las sube a `face-inbox/<usuario>/`.
3. Con `reconocer` (o `gpu` no basta: hace falta `reconocer`) el script las baja,
   calcula el vector en la GPU, lo escribe en `face_embeddings` y borra las fotos.
4. En el inicio, **Activar con mi rostro**. La ventana de la PC pide mirar a la cámara.
   Si coincide, se arma la sesión y la ESP32 suma +15 por botella y +10 por lata.

Respaldo sin la app, con la cuenta ya creada:

```bash
python first_contact.py registrar 100001
python first_contact.py listar
python first_contact.py borrar 100001
```

`registrar` también escribe el vector en Supabase.

## 4. Ajustes

| Problema | Ajuste |
|---|---|
| Confunde a dos personas | Subir `UMBRAL` a 0.50–0.55 |
| No reconoce a alguien registrado | Bajar a 0.40, o registrarlo otra vez con la luz de la máquina |
| Abre otra cámara | `CAMARA=1` o la ruta `/dev/v4l/by-id/...` |
| Pocos FPS en la Jetson | `sudo nvpmodel -m 0 && sudo jetson_clocks` y `DET_SIZE=320` |
| `CUDAExecutionProvider` no aparece | Reinstalar `onnxruntime-gpu` del índice que corresponde (PC o Jetson) |
| La app dice que no hay máquina | El `MACHINE_CODE` del `.env` y el de la ESP32 tienen que ser `ECO-48FM6V` |

`SIN_CONEXION=1` solo demuestra el reconocimiento contra `faces_db.json`. No arma la máquina
ni lee Supabase.

## Archivos

- `first_contact.py`: cámara, modelo en la GPU, registro y disparadores.
- `ecorewards.py`: lecturas y escrituras en Supabase.
- `faces_db.json`: solo aparece en el registro local o con `SIN_CONEXION=1`. No se sube a Git.
