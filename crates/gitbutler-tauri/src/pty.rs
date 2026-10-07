use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter, Manager, State};

pub type TerminalId = String;

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Running shell sessions keyed by terminal ID.
#[derive(Default)]
pub struct PtyRegistry(Mutex<HashMap<TerminalId, PtySession>>);

impl PtyRegistry {
    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<TerminalId, PtySession>>, String> {
        self.0
            .lock()
            .map_err(|e| format!("Failed to lock registry: {e}"))
    }

    fn with_session<T>(
        &self,
        terminal_id: &str,
        f: impl FnOnce(&mut PtySession) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut sessions = self.sessions()?;
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| "Terminal not found".to_string())?;
        f(session)
    }

    /// Kills every running shell; called when the app quits.
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions() {
            for (_, mut session) in sessions.drain() {
                session.child.kill().ok();
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    data: String,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

#[tauri::command(async)]
pub fn spawn_terminal(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<TerminalId, String> {
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
    cmd.cwd(cwd);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let terminal_id = uuid::Uuid::new_v4().to_string();
    registry.sessions()?.insert(
        terminal_id.clone(),
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    // portable-pty reads block, so stream output from a dedicated thread.
    let id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
            app.emit(&format!("terminal://{id}/output"), PtyOutputEvent { data })
                .ok();
        }
        if let Ok(mut sessions) = app.state::<PtyRegistry>().sessions() {
            sessions.remove(&id);
        }
        app.emit(&format!("terminal://{id}/exit"), ()).ok();
    });

    Ok(terminal_id)
}

#[tauri::command(async)]
pub fn write_to_terminal(
    registry: State<'_, PtyRegistry>,
    terminal_id: TerminalId,
    data: String,
) -> Result<(), String> {
    registry.with_session(&terminal_id, |session| {
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|()| session.writer.flush())
            .map_err(|e| format!("Failed to write to terminal: {e}"))
    })
}

#[tauri::command(async)]
pub fn resize_terminal(
    registry: State<'_, PtyRegistry>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.with_session(&terminal_id, |session| {
        session
            .master
            .resize(pty_size(cols, rows))
            .map_err(|e| format!("Failed to resize terminal: {e}"))
    })
}

#[tauri::command(async)]
pub fn kill_terminal(
    registry: State<'_, PtyRegistry>,
    terminal_id: TerminalId,
) -> Result<(), String> {
    let mut session = registry
        .sessions()?
        .remove(&terminal_id)
        .ok_or_else(|| "Terminal not found".to_string())?;
    session
        .child
        .kill()
        .map_err(|e| format!("Failed to kill terminal: {e}"))
}
