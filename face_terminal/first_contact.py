"""Reconocimiento facial de Eco-Rewards (InsightFace en la GPU + webcam).

Esta PC carga buffalo_l en la VRAM con CUDAExecutionProvider. El mismo archivo,
en una Jetson Orin Nano Super, usa ese provider sobre la memoria unificada.
Los rostros salen de Supabase (face_embeddings), no de un JSON local.

Uso:
  python first_contact.py gpu                 # solo carga el modelo y muestra la VRAM
  python first_contact.py reconocer           # espera un disparador y abre la sesión
  python first_contact.py registrar <cuenta>  # respaldo: registra desde esta cámara
  python first_contact.py listar
  python first_contact.py borrar <cuenta>

Disparadores de reconocer:
  ESPACIO          botón de la máquina: identifica a cualquiera registrado
  botón de la app  verifica a la persona que pidió la máquina ECO-48FM6V
  T                terminar la sesión abierta
  Q / ESC          salir

Opciones (entorno o .env):
  CAMARA, DET_SIZE, UMBRAL, SIN_CONEXION
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MACHINE_CODE
"""

# --- Arreglo de cuDNN (Linux + GPU): debe ir ANTES de importar cv2 / onnxruntime / insightface ---
import os
import sys
import sysconfig

_CUDNN = os.path.join(sysconfig.get_paths()["purelib"], "nvidia", "cudnn", "lib")
_LINK = os.path.join(_CUDNN, "libcudnn.so")

if sys.platform.startswith("linux") and os.path.isdir(_CUDNN):
    if not os.path.exists(_LINK):
        try:
            os.symlink("libcudnn.so.9", _LINK)
        except OSError:
            pass
    if _CUDNN not in os.environ.get("LD_LIBRARY_PATH", ""):
        os.environ["LD_LIBRARY_PATH"] = _CUDNN + ":" + os.environ.get("LD_LIBRARY_PATH", "")
        os.execv(sys.executable, [sys.executable] + sys.argv)
# ------------------------------------------------------------------------------------------------

import json
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).with_name(".env"))
except ImportError:
    pass

import ecorewards

BASE = Path(__file__).parent
DB_FILE = BASE / "faces_db.json"
MODELO = "buffalo_l"
UMBRAL = float(os.environ.get("UMBRAL", "0.45"))
MUESTRAS = 5
DET_SIZE = int(os.environ.get("DET_SIZE", "640"))
CONFIRMAR = 3
ESPERA_REPETIR = 10
BUSQUEDA_SEGUNDOS = 25
MIN_MUESTRAS_APP = 3
SIN_CONEXION = os.environ.get("SIN_CONEXION", "0") == "1" or not ecorewards.configurado()


# ----------------------------------------------------------------------------- GPU

def memoria_gpu():
    try:
        return subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"],
            text=True,
            timeout=5,
        ).strip()
    except Exception as exc:
        return f"nvidia-smi no disponible ({exc})"


def anunciar_gpu(providers):
    print("=" * 68)
    print("Simulación Jetson Orin Nano Super")
    print(f"GPU de esta PC: {memoria_gpu()}")
    print(f"Provider ONNX: {providers[0]}")
    print("buffalo_l quedó cargado en la memoria de vídeo (CUDAExecutionProvider).")
    print("En la Jetson Orin Nano Super el mismo script usa ese provider")
    print("sobre la memoria unificada. No cambia ninguna línea de este archivo.")
    print("=" * 68)


def cargar_modelo():
    disponibles = ort.get_available_providers()
    print("Providers disponibles:", disponibles)
    if "CUDAExecutionProvider" not in disponibles:
        sys.exit(
            "CUDAExecutionProvider no está disponible. "
            "Instala onnxruntime-gpu (en esta PC con pip; en la Jetson, desde el índice de JetPack). "
            "Esta simulación no continúa en CPU."
        )
    if hasattr(ort, "preload_dlls"):
        ort.preload_dlls()

    app = FaceAnalysis(
        name=MODELO,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
    usados = []
    for nombre, modelo in app.models.items():
        try:
            proveedores = modelo.session.get_providers()
        except Exception:
            proveedores = []
        if "CUDAExecutionProvider" not in proveedores:
            sys.exit(
                f"La red '{nombre}' no entró a la GPU. Providers: {proveedores or 'desconocidos'}"
            )
        usados = proveedores
        print(f"  {nombre}: {proveedores[0]}")
    anunciar_gpu(usados)
    return app


def abrir_camara():
    fuente = os.environ.get("CAMARA", "0")
    fuente = int(fuente) if fuente.isdigit() else fuente
    if sys.platform.startswith("win") and isinstance(fuente, int):
        cap = cv2.VideoCapture(fuente, cv2.CAP_DSHOW)
    else:
        cap = cv2.VideoCapture(fuente)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    cap.set(cv2.CAP_PROP_FPS, 30)
    if not cap.isOpened():
        ayuda = "v4l2-ctl --list-devices" if sys.platform.startswith("linux") else "prueba con CAMARA=1"
        sys.exit(f"No pude abrir la cámara. Revisa con: {ayuda}")
    return cap


# ----------------------------------------------------------------------------- vectores

def vector_de(emb):
    arr = np.asarray(emb, dtype=np.float32).ravel()
    arr = arr / (np.linalg.norm(arr) + 1e-9)
    return arr


def matriz(personas):
    if not personas:
        return np.zeros((0, ecorewards.EMBED_DIM), dtype=np.float32)
    m = np.array([vector_de(p["embedding"]) for p in personas], dtype=np.float32)
    return m


def mejor_match(emb, personas, m):
    if not personas:
        return None, -1.0
    sims = m @ vector_de(emb)
    i = int(np.argmax(sims))
    mejor = float(sims[i])
    return (personas[i], mejor) if mejor >= UMBRAL else (None, mejor)


def cara_mas_grande(caras):
    return max(caras, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


def cargar_json_local():
    if not DB_FILE.exists():
        return []
    with open(DB_FILE, encoding="utf-8") as f:
        db = json.load(f)
    personas = []
    for persona in db.get("personas", {}).values():
        emb = persona.get("embedding") or []
        if len(emb) != ecorewards.EMBED_DIM:
            continue
        personas.append({
            "user_id": persona.get("profile_id"),
            "cuenta": persona.get("cuenta"),
            "nombre": persona.get("nombre") or persona.get("cuenta"),
            "embedding": emb,
        })
    return personas


def guardar_json_local(cuenta, perfil, emb):
    db = {"modelo": f"insightface/{MODELO}", "umbral": UMBRAL, "personas": {}}
    if DB_FILE.exists():
        with open(DB_FILE, encoding="utf-8") as f:
            db = json.load(f)
    db.setdefault("personas", {})
    db["personas"][cuenta] = {
        "cuenta": cuenta,
        "nombre": ecorewards.nombre(perfil) if perfil else cuenta,
        "email": perfil.get("email") if perfil else None,
        "profile_id": perfil["id"] if perfil else None,
        "registrado": datetime.now().isoformat(timespec="seconds"),
        "muestras": MUESTRAS,
        "embedding": [round(float(v), 6) for v in emb],
    }
    db["actualizado"] = datetime.now().isoformat(timespec="seconds")
    DB_FILE.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")


# ----------------------------------------------------------------------------- comandos de catálogo

def registrar(cuenta):
    perfil = None
    if not SIN_CONEXION:
        perfil = ecorewards.buscar_perfil(cuenta)
        if not perfil:
            sys.exit(f"No existe una cuenta Eco-Rewards con '{cuenta}'. Regístrate primero en la app web.")
        cuenta = perfil["account_number"] or cuenta
        print(f"Cuenta encontrada: {ecorewards.nombre(perfil)} (cuenta {perfil['account_number']}, "
              f"{perfil['points_balance']} pts)")

    print("Se guardará un vector de 512 números (no la foto).")
    if input("¿Aceptas? (s/n): ").strip().lower() != "s":
        print("Registro cancelado.")
        return

    app = cargar_modelo()
    cap = abrir_camara()
    muestras = []
    print(f"Registrando '{cuenta}'. ESPACIO = capturar, ESC = cancelar")

    while len(muestras) < MUESTRAS:
        ok, frame = cap.read()
        if not ok:
            continue
        faces = app.get(frame)
        vista = frame.copy()
        for f in faces:
            x1, y1, x2, y2 = map(int, f.bbox)
            cv2.rectangle(vista, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(vista, f"Muestra {len(muestras)}/{MUESTRAS} - ESPACIO para capturar",
                    (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.imshow("Registrar", vista)
        k = cv2.waitKey(1) & 0xFF
        if k == 27:
            break
        if k == 32 and len(faces) == 1:
            muestras.append(vector_de(faces[0].normed_embedding))
            print(f"Muestra {len(muestras)}/{MUESTRAS} guardada")
        elif k == 32:
            print("Debe haber exactamente 1 cara en la imagen.")

    cap.release()
    cv2.destroyAllWindows()
    if len(muestras) < MUESTRAS:
        print("Registro cancelado.")
        return

    emb = vector_de(np.mean(muestras, axis=0))
    guardar_json_local(cuenta, perfil, emb)
    if perfil and not SIN_CONEXION:
        ecorewards.reemplazar_embeddings(perfil["id"], [m.tolist() for m in muestras])
        print(f"Vector guardado en Supabase para {ecorewards.nombre(perfil)}.")
    else:
        print(f"Vector guardado solo en {DB_FILE.name} (sin conexión).")


def listar():
    if SIN_CONEXION:
        personas = cargar_json_local()
        origen = DB_FILE.name
    else:
        personas = ecorewards.listar_rostros()
        origen = "Supabase face_embeddings"
    if not personas:
        print(f"No hay rostros en {origen}.")
        return
    vistos = []
    print(f"{len(personas)} muestras en {origen}:")
    for p in personas:
        clave = p["user_id"] or p["cuenta"]
        if clave in vistos:
            continue
        vistos.append(clave)
        print(f"  - {p['cuenta'] or '-':<12} {p['nombre']}")


def borrar(cuenta):
    if SIN_CONEXION:
        sys.exit("SIN_CONEXION=1 no puede borrar rostros de Supabase.")
    perfil = ecorewards.buscar_perfil(cuenta)
    if not perfil:
        sys.exit(f"No existe una cuenta Eco-Rewards con '{cuenta}'.")
    ecorewards.borrar_rostro(perfil["id"])
    print(f"Se borró el rostro de {ecorewards.nombre(perfil)}.")


def mostrar_gpu():
    cargar_modelo()
    print("Listo. El modelo sigue en la VRAM hasta que este proceso termine.")


# ----------------------------------------------------------------------------- sesión y reconocimiento

class Sesion:
    """Sigue la sesión de la máquina sin congelar el video."""

    def __init__(self):
        self.maquina = None
        self.info = None
        self.mensaje = ""
        self.ultimo = {}
        self._lock = threading.Lock()
        self._ocupado = False
        if not SIN_CONEXION:
            self.maquina = ecorewards.obtener_maquina()
            threading.Thread(target=self._seguir, daemon=True).start()

    def abrir(self, persona, request_id=None):
        if SIN_CONEXION or self._ocupado or self.info:
            if request_id and not SIN_CONEXION:
                ecorewards.cerrar_peticion(request_id, "failed", error="La máquina ya está en uso")
            return
        pid = persona.get("user_id")
        if not pid:
            self.mensaje = f"'{persona.get('nombre')}' no está vinculada a una cuenta"
            if request_id:
                ecorewards.cerrar_peticion(request_id, "failed", error=self.mensaje)
            return
        if time.time() - self.ultimo.get(pid, 0) < ESPERA_REPETIR:
            if request_id:
                ecorewards.cerrar_peticion(request_id, "failed", error="Espera unos segundos e inténtalo de nuevo")
            return
        self._ocupado = True

        def trabajo():
            try:
                sesion = ecorewards.abrir_sesion(self.maquina["id"], pid)
                if sesion:
                    self.mensaje = f"Sesión abierta para {persona['nombre']}"
                    print(self.mensaje)
                    if request_id:
                        ecorewards.cerrar_peticion(request_id, "matched", session_id=sesion["id"])
                else:
                    self.mensaje = "La máquina ya está en uso"
                    print(self.mensaje)
                    if request_id:
                        ecorewards.cerrar_peticion(request_id, "failed", error=self.mensaje)
            except Exception as exc:
                self.mensaje = f"Error al abrir sesión: {exc}"
                print(self.mensaje)
                if request_id:
                    try:
                        ecorewards.cerrar_peticion(request_id, "failed", error=self.mensaje)
                    except Exception:
                        pass
            finally:
                self._ocupado = False

        threading.Thread(target=trabajo, daemon=True).start()

    def terminar(self):
        if self.info and self.info.get("id"):
            threading.Thread(target=ecorewards.terminar_sesion, args=(self.info["id"],), daemon=True).start()

    def _seguir(self):
        while True:
            try:
                s = ecorewards.sesion_activa(self.maquina["id"])
                with self._lock:
                    if s:
                        perfil = ecorewards.perfil_por_id(s["user_id"])
                        fin = datetime.fromisoformat(s["expires_at"].replace("Z", "+00:00"))
                        inicio = self.info["inicio"] if self.info and self.info["id"] == s["id"] else perfil["points_balance"]
                        self.info = {
                            "id": s["id"],
                            "user_id": s["user_id"],
                            "nombre": ecorewards.nombre(perfil),
                            "puntos": perfil["points_balance"],
                            "inicio": inicio,
                            "items": s["items_processed"],
                            "fuente": s["source"],
                            "segundos": max(0, int((fin - datetime.now(timezone.utc)).total_seconds())),
                        }
                    elif self.info:
                        self.ultimo[self.info["user_id"]] = time.time()
                        print(f"Sesión terminada: {self.info['nombre']} ganó {self.info['puntos'] - self.info['inicio']} pts")
                        self.info = None
            except Exception as exc:
                self.mensaje = f"Sin conexión: {exc}"
            time.sleep(1.5)


def procesar_trabajo(app, trabajo):
    muestras = []
    paths = trabajo.get("storage_paths") or []
    try:
        for path in paths:
            blob = ecorewards.descargar_foto(path)
            frame = cv2.imdecode(np.frombuffer(blob, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                continue
            caras = app.get(frame)
            if not caras:
                continue
            muestras.append(vector_de(cara_mas_grande(caras).normed_embedding))
        if len(muestras) < MIN_MUESTRAS_APP:
            raise RuntimeError(f"Solo {len(muestras)} fotos tenían una cara (hacen falta {MIN_MUESTRAS_APP})")
        ecorewards.reemplazar_embeddings(trabajo["user_id"], [m.tolist() for m in muestras])
        ecorewards.cerrar_trabajo(trabajo["id"], "done")
        print(f"Rostro guardado en Supabase ({len(muestras)} muestras) para {trabajo['user_id']}")
    except Exception as exc:
        print(f"Registro fallido {trabajo['id']}: {exc}")
        try:
            ecorewards.cerrar_trabajo(trabajo["id"], "failed", error=str(exc)[:300])
        except Exception:
            pass
    finally:
        try:
            ecorewards.borrar_fotos(paths)
        except Exception as exc:
            print(f"No pude borrar las fotos temporales: {exc}")


def reconocer():
    app = cargar_modelo()
    sesion = Sesion()
    if SIN_CONEXION:
        print("Modo SIN CONEXIÓN: solo reconocimiento local, sin armar la máquina.")
        personas = cargar_json_local()
    else:
        print(f"Máquina: {sesion.maquina['name']} ({sesion.maquina['machine_code']})")
        print("ESPACIO = botón de la máquina. La app también puede pedir la verificación.")
        personas = []

    cap = abrir_camara()
    m = matriz(personas)
    busqueda = None
    en_curso = set()
    proximo = 0.0
    t_prev = time.time()
    racha_id, racha = None, 0

    def iniciar(user_id, request_id, hasta):
        nonlocal busqueda, racha, racha_id
        busqueda = {"user_id": user_id, "request_id": request_id, "hasta": hasta}
        racha, racha_id = 0, None
        if request_id:
            en_curso.add(request_id)
        print("Mira a la cámara.")

    while True:
        ahora = time.time()
        if not SIN_CONEXION and ahora >= proximo:
            proximo = ahora + 2
            try:
                ecorewards.expirar_peticiones(sesion.maquina["id"])
                trabajos = ecorewards.trabajos_pendientes()
                if trabajos:
                    procesar_trabajo(app, trabajos[0])
                personas = ecorewards.listar_rostros()
                m = matriz(personas)
                if busqueda is None:
                    for peticion in ecorewards.peticiones_pendientes(sesion.maquina["id"]):
                        if peticion["id"] in en_curso:
                            continue
                        fin = datetime.fromisoformat(peticion["expires_at"].replace("Z", "+00:00"))
                        iniciar(peticion["user_id"], peticion["id"], fin.timestamp())
                        break
            except Exception as exc:
                sesion.mensaje = f"Sin conexión: {exc}"

        ok, frame = cap.read()
        if not ok:
            continue

        if busqueda and time.time() > busqueda["hasta"]:
            if busqueda["request_id"]:
                try:
                    ecorewards.cerrar_peticion(busqueda["request_id"], "failed", error="No se reconoció el rostro")
                except Exception as exc:
                    sesion.mensaje = str(exc)
                en_curso.discard(busqueda["request_id"])
            sesion.mensaje = "No se reconoció el rostro"
            busqueda = None
            racha, racha_id = 0, None

        caras = app.get(frame) if busqueda else []
        if caras:
            caras.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
        for idx, f in enumerate(caras):
            persona, score = mejor_match(f.normed_embedding, personas, m)
            x1, y1, x2, y2 = map(int, f.bbox)
            color = (0, 255, 0) if persona else (0, 0, 255)
            etiqueta = f"{persona['nombre']} ({score:.2f})" if persona else f"desconocido ({score:.2f})"
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, etiqueta, (x1, max(y1 - 10, 20)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
            if idx != 0 or not busqueda:
                continue
            esperado = busqueda["user_id"]
            aceptada = persona if persona and (esperado is None or persona["user_id"] == esperado) else None
            clave = (aceptada or {}).get("user_id")
            racha = racha + 1 if clave and clave == racha_id else (1 if clave else 0)
            racha_id = clave
            if aceptada and racha >= CONFIRMAR:
                request_id = busqueda["request_id"]
                busqueda = None
                racha, racha_id = 0, None
                if SIN_CONEXION:
                    sesion.mensaje = f"Reconocido: {aceptada['nombre']}"
                else:
                    sesion.abrir(aceptada, request_id)

        if not caras:
            racha, racha_id = 0, None

        info = sesion.info
        if busqueda:
            if busqueda["user_id"]:
                lineas = ["Mira a la camara", "Verificando el rostro de la app"]
            else:
                lineas = ["Mira a la camara", "Boton de la maquina"]
            fondo = (0, 140, 180)
        elif info:
            ganados = info["puntos"] - info["inicio"]
            lineas = [
                f"Hola, {info['nombre']}!  ({info['fuente']})",
                f"{info['puntos']} pts  (+{ganados})  articulos: {info['items']}",
                f"Deposita tus botellas y latas - cierra en {info['segundos']}s",
            ]
            fondo = (40, 110, 40)
        else:
            extra = sesion.mensaje or "ESPACIO para identificarte"
            lineas = ["Esperando disparador", extra[:70]]
            fondo = (50, 50, 50)
        alto = 30 + 32 * len(lineas)
        cv2.rectangle(frame, (0, frame.shape[0] - alto), (frame.shape[1], frame.shape[0]), fondo, -1)
        for i, texto in enumerate(lineas):
            cv2.putText(frame, texto, (20, frame.shape[0] - alto + 35 + 32 * i),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

        fps = 1.0 / max(time.time() - t_prev, 1e-6)
        t_prev = time.time()
        cv2.putText(frame, f"FPS: {fps:.0f}  GPU", (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

        cv2.imshow("Reconocer - Eco-Rewards", frame)
        k = cv2.waitKey(1) & 0xFF
        if k in (ord("q"), 27):
            break
        if k == ord("t"):
            sesion.terminar()
        if k == 32 and busqueda is None and not sesion.info:
            iniciar(None, None, time.time() + BUSQUEDA_SEGUNDOS)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "gpu":
        mostrar_gpu()
    elif len(sys.argv) >= 3 and sys.argv[1] == "registrar":
        registrar(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == "reconocer":
        reconocer()
    elif len(sys.argv) >= 2 and sys.argv[1] == "listar":
        listar()
    elif len(sys.argv) >= 3 and sys.argv[1] == "borrar":
        borrar(sys.argv[2])
    else:
        print(__doc__)
