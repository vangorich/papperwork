use super::{client, AssistRequest};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::Duration,
};
use uuid::Uuid;

const LIMIT: Duration = Duration::from_secs(5);
const PREVIEW: &str = "  仅合成选区\n\n`quoted` \"line\"\n";
fn input(endpoint: String) -> AssistRequest {
    AssistRequest {
        request_id: Uuid::new_v4().to_string(),
        text: PREVIEW.into(),
        model: "fixture-model".into(),
        api_key: Some("fixture-only".into()),
        endpoint,
    }
}
fn run(request: AssistRequest, limit: Duration) -> super::Result<String> {
    let job = client::begin(&request.request_id)?;
    client::complete(request, job, limit)
}
fn serve(
    f: impl FnOnce(TcpStream, String, Value) + Send + 'static,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(LIMIT)).unwrap();
        socket.set_write_timeout(Some(LIMIT)).unwrap();
        let mut reader = BufReader::new(&mut socket);
        let mut headers = String::new();
        while !headers.ends_with("\r\n\r\n") {
            assert!(reader.read_line(&mut headers).unwrap() > 0)
        }
        let length = headers
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
            .unwrap()
            .1
            .trim()
            .parse()
            .unwrap();
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        f(socket, headers, serde_json::from_slice(&body).unwrap());
    });
    (endpoint, server)
}
fn response(socket: &mut TcpStream, status: &str, body: &[u8]) {
    write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
    socket.write_all(body).unwrap();
}
fn reply(reason: &str, content: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"choices":[{"finish_reason":reason,"message":{"role":"assistant","content":content}}]})).unwrap()
}

#[test]
fn winhttp_only_posts_the_selected_preview_and_header_token() {
    let synthetic_document = [
        "PRIVATE-NEIGHBOUR unapplied mail attachment",
        PREVIEW,
        "%PDF-FAKE-EXCLUDED",
    ];
    let (url, server) = serve(|mut socket, headers, body| {
        assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        let lower = headers.to_ascii_lowercase();
        assert!(lower.contains("\r\nauthorization: bearer fixture-only\r\n"));
        assert!(!lower.contains("\r\ncookie:") && !lower.contains("\r\nreferer:"));
        assert!(!body.to_string().contains("fixture-only"));
        assert_eq!(
            body,
            json!({"model":"fixture-model", "messages":[{"role":"system", "content":client::SYSTEM_PROMPT}, {"role":"user","content":PREVIEW}]})
        );
        response(&mut socket, "200 OK", &reply("stop", "# 合成 Markdown\n"));
    });
    let mut request = input(url);
    request.text = synthetic_document[1].into();
    assert_eq!(run(request, LIMIT).unwrap(), "# 合成 Markdown\n");
    server.join().unwrap();
}

#[test]
fn https_starts_tls_before_sending_the_preview_or_key() {
    // Exercise the HTTPS-specific setup without installing a test CA or consulting a trust store.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(LIMIT)).unwrap();
        let mut prefix = [0; 2];
        socket.read_exact(&mut prefix).unwrap();
        tx.send(prefix).unwrap(); // No certificate or provider response is supplied.
    });
    assert!(run(input(url), LIMIT).is_err());
    assert_eq!(rx.recv_timeout(LIMIT).unwrap(), [0x16, 0x03]);
    server.join().unwrap();
}

#[test]
fn winhttp_does_not_forward_the_token_or_preview_to_redirects() {
    let other = TcpListener::bind("127.0.0.1:0").unwrap();
    other.set_nonblocking(true).unwrap();
    let destination = other.local_addr().unwrap();
    let (url, server) = serve(move |mut socket, _, _| {
        write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{destination}/other\r\nSet-Cookie: hidden=fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    assert_eq!(run(input(url), LIMIT), Err("http"));
    server.join().unwrap();
    assert_eq!(
        other.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn winhttp_rejects_http_and_completion_errors_without_echoing_content() {
    for (status, body, expected) in [
        ("401 Unauthorized", PREVIEW.as_bytes().to_vec(), "auth"),
        ("429 Too Many Requests", PREVIEW.as_bytes().to_vec(), "rate"),
        ("200 OK", reply("length", PREVIEW), "incomplete"),
        ("200 OK", reply("stop", " \t"), "response"),
        (
            "200 OK",
            b"{\"error\":{\"message\":\"fixture-only\"}}".to_vec(),
            "http",
        ),
        ("200 OK", b"{invalid private content}".to_vec(), "response"),
    ] {
        let (url, server) = serve(move |mut socket, headers, _| {
            if expected == "auth" {
                assert!(!headers.to_ascii_lowercase().contains("\r\nauthorization:"));
                write!(socket, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                response(&mut socket, status, &body);
            }
        });
        let mut request = input(url);
        request.api_key = None;
        assert_eq!(run(request, LIMIT), Err(expected));
        server.join().unwrap();
    }
}

#[test]
fn winhttp_rejects_truncated_transfers_and_declared_or_streamed_oversize() {
    let body = reply("stop", "seems complete");
    let (url, server) = serve(move |mut socket, _, _| {
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len() + 1
        )
        .unwrap();
        socket.write_all(&body).unwrap();
    });
    let result = run(input(url), LIMIT);
    assert!(matches!(result, Err("incomplete" | "network" | "response")));
    server.join().unwrap();
    let (url, server) = serve(|mut socket, _, _| {
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: 5000000000\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
    });
    assert_eq!(run(input(url), LIMIT), Err("response_size"));
    server.join().unwrap();
    let (url, server) = serve(|mut socket, _, _| {
        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n400001\r\n").unwrap();
        let _ = socket.write_all(&vec![b'x'; 4 * 1024 * 1024 + 1]);
        let _ = socket.write_all(b"\r\n0\r\n\r\n");
    });
    assert_eq!(run(input(url), LIMIT), Err("response_size"));
    server.join().unwrap();
}

#[test]
fn cancelling_an_active_winhttp_request_closes_its_connection() {
    let (tx, rx) = mpsc::channel();
    let (url, server) = serve(move |mut socket, _, _| {
        tx.send(()).unwrap();
        let disconnected = socket.read(&mut [0u8; 1]);
        assert!(
            matches!(disconnected, Ok(0))
                || disconnected.is_err_and(|e| matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ))
        );
    });
    let request = input(url);
    let id = request.request_id.clone();
    let client = thread::spawn(move || run(request, LIMIT));
    rx.recv_timeout(LIMIT).unwrap();
    client::cancel(&id).unwrap();
    assert_eq!(client.join().unwrap(), Err("cancelled"));
    server.join().unwrap();
}

#[test]
fn early_cancel_and_end_to_end_deadline_are_enforced() {
    let request = input("http://127.0.0.1:1".into());
    client::cancel(&request.request_id).unwrap();
    assert_eq!(run(request, LIMIT), Err("cancelled"));
    let (url, server) = serve(|mut socket, _, _| {
        let _ = socket.read(&mut [0u8; 1]);
    });
    assert_eq!(run(input(url), Duration::from_millis(500)), Err("timeout"));
    server.join().unwrap();
}

#[test]
fn destination_validation_is_native_and_does_not_resolve_or_reach_the_network() {
    for value in [
        "http://example.test/v1",
        "http://localhost.example.test",
        "http://127.1",
        "http://0x7f000001",
        "http://example.test:443",
        "file:///tmp/doc",
        "https://token@example.test",
        "https://@example.test",
        "https://example.test/v1?",
        "https://example.test/v1#",
        "https://example.test:0",
        "https:////example.test",
        "https:example.test/prefix://unused",
        "https://example.test/v1/../x",
        "https://example.test/v1/%2f",
    ] {
        assert_eq!(client::endpoint(value), Err("endpoint"));
    }
    for (value, expected) in [
        (
            "https://Example.test:443/",
            "https://example.test/v1/chat/completions",
        ),
        (
            "https://example.test/provider/v1/",
            "https://example.test/provider/v1/chat/completions",
        ),
        (
            "http://[::1]:11434/v1/chat/completions",
            "http://[::1]:11434/v1/chat/completions",
        ),
    ] {
        assert_eq!(client::endpoint(value).unwrap().as_str(), expected);
    }
}

#[test]
fn ipc_refuses_any_non_contract_field_and_oversized_preview() {
    for field in [
        "files", "path", "messages", "history", "tools", "images", "pdf",
    ] {
        let mut data = json!({"requestId":Uuid::new_v4().to_string(),"text":"fixture", "endpoint":"http://127.0.0.1:1", "model":"fixture"});
        data[field] = json!(["EXCLUDED"]);
        assert!(serde_json::from_value::<AssistRequest>(data).is_err());
    }
    let mut request = input("http://127.0.0.1:1".into());
    request.text = "字".repeat(360_000);
    assert_eq!(run(request, LIMIT), Err("input_size"));
    let mut request = input("http://127.0.0.1:1".into());
    request.api_key = Some("invalid\r\nkey: x".into());
    assert_eq!(run(request, LIMIT), Err("key"));
}
