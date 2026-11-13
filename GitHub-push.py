#!/usr/bin/env python3
"""
GitHub Repo Sync Tool
======================
Ek baar config save karo, phir menu se:
  1) Upload    -> diye gaye folder ka poora content repo me ADD/PUSH karega
  2) Delete    -> GitHub repo ko poori tarah EMPTY kar dega
  3) Overwrite -> repo ko clear karke diye gaye folder ka content se REPLACE karega

Har operation FAIL hone par khud-ba-khud RETRY karta hai jab tak SUCCESS na ho.

SECURITY NOTE:
--------------
Apna Personal Access Token kabhi kisi ke saath share na karein aur kabhi
GitHub par public code me hardcode na karein. Agar token leak ho chuka hai,
turant https://github.com/settings/tokens par jaake usko REVOKE karke naya
banayein.
"""

import os
import sys
import json
import shutil
import subprocess
import time
import tempfile

# --------------------------------------------------------------------------- #
#  Auto-install required packages
# --------------------------------------------------------------------------- #

REQUIRED_PACKAGES = {
    "rich": "rich",  # import name -> pip package name
}


def ensure_packages_installed():
    """Check required packages, auto-install any that are missing."""
    missing = []
    for import_name, pip_name in REQUIRED_PACKAGES.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append(pip_name)

    if not missing:
        return

    print(f"Missing packages detected: {', '.join(missing)}")
    print("Installing automatically, please wait...\n")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", *missing],
            check=True,
        )
    except subprocess.CalledProcessError:
        print("Auto-install failed. Try manually:")
        print(f"  {sys.executable} -m pip install {' '.join(missing)}")
        sys.exit(1)
    print("Packages installed successfully.\n")


ensure_packages_installed()

# Ab safely import kar sakte hain
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt, Confirm
from rich.text import Text
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich import box

console = Console()

CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".github_sync_tool_config.json")

# ---- Pehle se diye gaye credentials (direct use, koi prompt nahi) ----
DEFAULT_CONFIG = {
    "username": "omkar-bhalke",
    "repo": "WP-PANAL",
    "token": "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",
}


# ----------------------------- Config Handling ----------------------------- #

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    return None


def save_config(username, repo, token):
    config = {"username": username, "repo": repo, "token": token}
    # Only owner can read this file (best-effort permission lock)
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except Exception:
        pass
    return config


def setup_config():
    console.print(Panel.fit("[bold cyan]GitHub Config Setup[/bold cyan]", box=box.ROUNDED))
    username = Prompt.ask("[yellow]GitHub username[/yellow]").strip()
    repo = Prompt.ask("[yellow]GitHub repo name[/yellow]").strip()
    token = Prompt.ask("[yellow]GitHub token (ghp_...)[/yellow]", password=True).strip()
    config = save_config(username, repo, token)
    console.print("[bold green]✔ Config saved.[/bold green]\n")
    return config


def get_repo_url(config):
    return f"https://{config['username']}:{config['token']}@github.com/{config['username']}/{config['repo']}.git"


# ----------------------------- Git Helpers ----------------------------- #

def run_cmd(cmd, cwd=None, check=True):
    """Run a shell command, return (success, output)."""
    result = subprocess.run(
        cmd, cwd=cwd, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    if check and result.returncode != 0:
        return False, result.stdout
    return True, result.stdout


def clone_repo(config, dest_dir):
    """Clone repo into dest_dir. Agar repo empty hai (koi branch nahi) to init karo."""
    url = get_repo_url(config)
    ok, out = run_cmd(["git", "clone", url, dest_dir], check=False)
    if ok and os.path.isdir(os.path.join(dest_dir, ".git")):
        # Identity hamesha set karo -- empty repo clone hone par bhi ye zaruri hai,
        # varna commit fail hoga (missing user.email/user.name) aur push kabhi nahi banega.
        run_cmd(["git", "config", "user.email", "sync-tool@local"], cwd=dest_dir)
        run_cmd(["git", "config", "user.name", config["username"]], cwd=dest_dir)

        # Agar clone hua repo "empty" hai (koi commit nahi -> unborn HEAD), to ek
        # normal named branch (main) par explicitly switch karo taaki commit/push
        # ke waqt koi ambiguity na ho.
        head_exists, _ = run_cmd(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=dest_dir, check=True)
        if not head_exists:
            run_cmd(["git", "checkout", "-b", "main"], cwd=dest_dir, check=False)
        return True

    # Clone fail ho sakta hai agar repo bilkul empty hai (no commits yet)
    if os.path.exists(dest_dir):
        shutil.rmtree(dest_dir, ignore_errors=True)
    os.makedirs(dest_dir, exist_ok=True)
    run_cmd(["git", "init"], cwd=dest_dir)
    run_cmd(["git", "remote", "add", "origin", url], cwd=dest_dir)
    run_cmd(["git", "config", "user.email", "sync-tool@local"], cwd=dest_dir)
    run_cmd(["git", "config", "user.name", config["username"]], cwd=dest_dir)
    # Try to fetch existing branch (main/master) if it exists
    run_cmd(["git", "fetch", "origin"], cwd=dest_dir, check=False)
    ok, _ = run_cmd(["git", "checkout", "main"], cwd=dest_dir, check=False)
    if not ok:
        ok2, _ = run_cmd(["git", "checkout", "master"], cwd=dest_dir, check=False)
        if not ok2:
            run_cmd(["git", "checkout", "-b", "main"], cwd=dest_dir)
    return True


# Git ka "magic" empty-tree hash -> unborn/fresh repo me bhi diff ke liye kaam karta hai
EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def commit_and_push(repo_dir, message):
    run_cmd(["git", "add", "-A"], cwd=repo_dir)

    # Repo me pehle se koi commit hai ya nahi (fresh repo par HEAD "unborn" hota hai)
    head_exists, _ = run_cmd(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=repo_dir, check=True)
    diff_base = "HEAD" if head_exists else EMPTY_TREE_SHA

    # Commit se PEHLE staged changes ki list nikal lo -> ye hi "report" banega
    diff_ok, diff_out = run_cmd(
        ["git", "diff", "--cached", "--name-status", diff_base], cwd=repo_dir, check=False
    )
    changed_files = [line for line in diff_out.strip().splitlines() if line] if diff_ok else []

    ok, out = run_cmd(["git", "commit", "-m", message], cwd=repo_dir, check=False)

    # Branch naam nikalo -> symbolic-ref unborn HEAD par bhi kaam karta hai (rev-parse nahi karta)
    branch_ok, branch_out = run_cmd(
        ["git", "symbolic-ref", "--short", "HEAD"], cwd=repo_dir, check=True
    )
    branch = branch_out.strip() if branch_ok and branch_out.strip() else "main"

    push_ok, push_out = run_cmd(
        ["git", "push", "-u", "origin", branch], cwd=repo_dir, check=True
    )
    return push_ok, push_out, changed_files



STATUS_LABELS = {
    "A": "[bold green]Added[/bold green]",
    "M": "[bold yellow]Modified[/bold yellow]",
    "D": "[bold red]Deleted[/bold red]",
    "R": "[bold cyan]Renamed[/bold cyan]",
}


def print_upload_report(repo_name, changed_files):
    """Server (GitHub repo) par kaunsi files gayi/badli, uska report table."""
    if not changed_files:
        console.print(Panel.fit(
            "[yellow]Koi file change nahi hui — repo already up to date tha.[/yellow]",
            title="📄 Report", box=box.ROUNDED
        ))
        return

    table = Table(title=f"📄 Report: {repo_name} par server pe gayi files", box=box.ROUNDED)
    table.add_column("Status", justify="left")
    table.add_column("File", justify="left")

    for line in changed_files:
        parts = line.split("\t")
        status_code = parts[0][0] if parts else "?"
        # Rename lines: "R100\told\tnew"
        if status_code == "R" and len(parts) >= 3:
            file_name = f"{parts[1]} → {parts[2]}"
        else:
            file_name = parts[1] if len(parts) > 1 else line

        label = STATUS_LABELS.get(status_code, f"[white]{status_code}[/white]")
        table.add_row(label, file_name)

    console.print(table)


def clear_repo_dir(repo_dir):
    """Repo folder ke andar ke sab files/folders delete karo (.git chhod ke)."""
    for name in os.listdir(repo_dir):
        if name == ".git":
            continue
        full_path = os.path.join(repo_dir, name)
        if os.path.isdir(full_path):
            shutil.rmtree(full_path, ignore_errors=True)
        else:
            os.remove(full_path)


def copy_folder_contents(src_folder, dest_repo_dir):
    """src_folder ke andar ki sab files/folders dest_repo_dir me copy karo."""
    for name in os.listdir(src_folder):
        src_path = os.path.join(src_folder, name)
        dest_path = os.path.join(dest_repo_dir, name)
        if os.path.isdir(src_path):
            shutil.copytree(src_path, dest_path, dirs_exist_ok=True)
        else:
            shutil.copy2(src_path, dest_path)


# ----------------------------- Retry Wrapper ----------------------------- #

def retry_until_success(operation_fn, max_wait_seconds=30, description=""):
    """
    operation_fn should return True on success, False on failure.
    Retries indefinitely with increasing backoff until it succeeds.
    """
    attempt = 1
    while True:
        console.print(f"\n[bold blue][Attempt {attempt}][/bold blue] {description} ...")
        try:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
                transient=True,
            ) as progress:
                progress.add_task(description="Working...", total=None)
                success = operation_fn()
        except Exception as e:
            console.print(f"  [red]Error: {e}[/red]")
            success = False

        if success:
            console.print(f"[bold green]✔ [SUCCESS][/bold green] {description} complete.")
            return True

        wait = min(attempt * 3, max_wait_seconds)
        console.print(f"[bold red]✘ [FAILED][/bold red] Retrying in {wait} seconds...")
        time.sleep(wait)
        attempt += 1


# ----------------------------- Core Operations ----------------------------- #

def op_upload(config, folder_path):
    report = []

    def _do():
        if not os.path.isdir(folder_path):
            console.print(f"  [red]Folder not found: {folder_path}[/red]")
            return False
        with tempfile.TemporaryDirectory() as tmp:
            clone_repo(config, tmp)
            copy_folder_contents(folder_path, tmp)
            ok, out, changed_files = commit_and_push(tmp, "Upload via github_sync_tool")
            if not ok:
                console.print(out[-500:] if out else "  push failed")
            else:
                report[:] = changed_files
            return ok

    retry_until_success(_do, description=f"Uploading '{folder_path}' to {config['repo']}")
    print_upload_report(config["repo"], report)


def op_delete(config):
    report = []

    def _do():
        with tempfile.TemporaryDirectory() as tmp:
            clone_repo(config, tmp)
            clear_repo_dir(tmp)
            ok, out, changed_files = commit_and_push(tmp, "Empty repo via github_sync_tool")
            if not ok:
                console.print(out[-500:] if out else "  push failed")
            else:
                report[:] = changed_files
            return ok

    retry_until_success(_do, description=f"Emptying repo {config['repo']}")
    print_upload_report(config["repo"], report)


def op_overwrite(config, folder_path):
    report = []

    def _do():
        if not os.path.isdir(folder_path):
            console.print(f"  [red]Folder not found: {folder_path}[/red]")
            return False
        with tempfile.TemporaryDirectory() as tmp:
            clone_repo(config, tmp)
            clear_repo_dir(tmp)
            copy_folder_contents(folder_path, tmp)
            ok, out, changed_files = commit_and_push(tmp, "Overwrite via github_sync_tool")
            if not ok:
                console.print(out[-500:] if out else "  push failed")
            else:
                report[:] = changed_files
            return ok

    retry_until_success(_do, description=f"Overwriting repo {config['repo']} with '{folder_path}'")
    print_upload_report(config["repo"], report)


# ----------------------------- Menu ----------------------------- #

def print_header(config):
    table = Table(show_header=False, box=box.SIMPLE, pad_edge=False)
    table.add_row("[bold]User[/bold]", f"[cyan]{config['username']}[/cyan]")
    table.add_row("[bold]Repo[/bold]", f"[cyan]{config['repo']}[/cyan]")
    console.print(Panel(table, title="[bold magenta]⚡ GitHub Sync Tool[/bold magenta]", box=box.ROUNDED))


def print_menu():
    menu = Table(show_header=False, box=box.SIMPLE)
    menu.add_row("[bold green]1[/bold green]", "Upload    - folder ka content repo me add/push karo")
    menu.add_row("[bold green]2[/bold green]", "Delete    - repo ko empty karo")
    menu.add_row("[bold green]3[/bold green]", "Overwrite - repo ko folder se replace karo")
    menu.add_row("[bold green]4[/bold green]", "Reconfigure - username/repo/token badlo")
    menu.add_row("[bold green]5[/bold green]", "Exit")
    console.print(menu)


def main_menu(config):
    while True:
        print_header(config)
        print_menu()
        choice = Prompt.ask("[bold yellow]Choose an option[/bold yellow]", choices=["1", "2", "3", "4", "5"])

        if choice == "1":
            folder = Prompt.ask("Folder path (jo upload karna hai)").strip()
            op_upload(config, folder)
        elif choice == "2":
            confirm = Confirm.ask("[bold red]Pakka? Repo poora EMPTY ho jayega[/bold red]", default=False)
            if confirm:
                op_delete(config)
        elif choice == "3":
            folder = Prompt.ask("Folder path (jis se overwrite karna hai)").strip()
            confirm = Confirm.ask("[bold red]Pakka? Repo ka purana content DELETE ho jayega[/bold red]", default=False)
            if confirm:
                op_overwrite(config, folder)
        elif choice == "4":
            config = setup_config()
        elif choice == "5":
            console.print("[bold cyan]Bye! 👋[/bold cyan]")
            sys.exit(0)


if __name__ == "__main__":
    cfg = DEFAULT_CONFIG
    main_menu(cfg)
