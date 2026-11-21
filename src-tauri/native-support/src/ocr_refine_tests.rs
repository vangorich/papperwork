use super::*;

fn hit(text: &str, left: f64, right: f64) -> Hit {
    Hit::new(
        text.into(),
        [(left, 4.), (right, 4.), (right, 18.), (left, 18.)],
    )
}

#[test]
fn bilingual_numbers_allow_width_and_segmentation_but_not_value_changes() {
    let mut tokens = vec![
        hit("４８", 2., 17.),
        hit("．", 18., 20.),
        hit("50", 21., 36.),
    ];
    merge_script(
        &mut tokens,
        vec![hit("48.50", 2., 36.)],
        Supplemental::Latin,
        64,
        32,
    );
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].text, "48.50");
    for (before, candidate) in [
        ("48.50", "485.0"),
        ("-12", "12"),
        ("12%", "12"),
        ("1,200.00", "1.200,00"),
        ("A12", "B12"),
    ] {
        let mut primary = vec![hit(before, 1., 40.)];
        merge_script(
            &mut primary,
            vec![hit(candidate, 1., 40.)],
            Supplemental::Latin,
            64,
            32,
        );
        assert_eq!(primary.len(), 1);
        assert_eq!(primary[0].text, before);
    }
}

#[test]
fn dense_alignment_abstains_instead_of_adding_duplicate_text() {
    let mut primary = vec![hit("原", 1., 20.); 8200];
    merge_script(
        &mut primary,
        vec![hit("10", 1., 20.)],
        Supplemental::Latin,
        64,
        32,
    );
    assert_eq!(primary.len(), 8200);
    // Wide overlapping boxes cannot allocate an arbitrary number of bucket indices.
    let full = Hit::new(
        "title".into(),
        [(0., 0.), (2048., 0.), (2048., 2048.), (0., 2048.)],
    );
    assert!(Index::new(&vec![full; 257], 2048, 2048).is_none());
}

#[test]
fn retries_do_not_duplicate_primary_words_or_import_neighboring_context() {
    let mut words = vec![hit("保留", 2., 24.)];
    let gap = Rect {
        l: 38.,
        t: 3.,
        r: 60.,
        b: 20.,
    };
    add_missing(
        &mut words,
        vec![
            hit("保留", 2., 24.),
            hit("新", 40., 57.),
            hit("其他", 100., 119.),
        ],
        gap,
        Map::ID,
        16.,
    );
    add_missing(&mut words, vec![hit("新", 40., 57.)], gap, Map::ID, 16.);
    assert_eq!(
        words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
        ["保留", "新"]
    );
}

#[test]
fn inverse_upright_mapping_includes_all_four_source_corners() {
    let (width, height) = (240, 120);
    for angle in [-7., 0.75, 10.] {
        let (_, w, h, to_source) = upright(&vec![255; width * height], width, height, angle, 240);
        let inverse = to_source.inverse();
        for &(x, y) in &[(0., 0.), (240., 0.), (0., 120.), (240., 120.)] {
            let (u, v) = inverse.point(x, y);
            assert!(u >= -1e-8 && u <= w as f64 + 1e-8 && v >= -1e-8 && v <= h as f64 + 1e-8);
            let (a, b) = to_source.point(u, v);
            assert!((x - a).abs() < 1e-8 && (y - b).abs() < 1e-8);
        }
    }
}
