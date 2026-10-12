"""Grids headless (docs/DATACUBE_HEADLESS_PYTHON_DESIGN_2026_10_11.md §4): a page's grid run by DataCube's own code in V8
-- ``grid.view()``, what the grid shows as DataCube computes it; ``grid.relation``, its rows at their finest level as
Pure, as Create a Class makes them; ``grid.to_pandas()``, every one of those rows from the frames' database -- each
checked against pandas computing the same, in the same cell, with no browser."""

import base64
import json
import unittest
from decimal import Decimal

import pandas as pd

import legend_lite as ll
from legend_lite import datacube
from legend_lite.engine import Engine

TRADES = pd.DataFrame({
    'region': ['EMEA', 'EMEA', 'AMER', 'APAC', 'AMER', 'EMEA'],
    'desk': ['Rates', 'FX', 'Rates', 'FX', 'FX', 'Rates'],
    'notional': [100.0, 250.5, 75.25, 10.0, 40.0, 1.5],
    'qty': [1, 2, 3, 4, 5, 6],
})


def column(view, name):
    """A view's column of values, by its name."""
    at = [c['name'] for c in view.columns].index(name)
    return [row[at] for row in view.rows]


def groups(view, measure):
    """A grouped view's level-1 groups: label -> the measure's value."""
    labels, values = column(view, '__tree'), column(view, measure)
    return {labels[i]: values[i] for i, t in enumerate(view.tree) if t['level'] == 1}


class Grids(unittest.TestCase):
    def setUp(self):
        self.page = ll.Page('Headless trades')

    def test_a_grouped_grid_shows_what_pandas_computes(self):
        grid = self.page.grid(TRADES, name='trades_grouped', rows=['region'], measures={'notional': 'sum', 'qty': 'sum'})
        view = grid.view()
        # as on screen: the groups' labels first, then the columns, each aggregated
        self.assertEqual([c['name'] for c in view.columns], ['__tree', 'desk', 'notional', 'qty'])
        expected = TRADES.groupby('region')[['notional', 'qty']].sum()
        self.assertEqual(groups(view, 'qty'), expected.qty.to_dict())
        for region, notional in groups(view, 'notional').items():
            self.assertIsInstance(notional, float)
            self.assertAlmostEqual(notional, expected.notional[region])
        # a column not measured shows its one value, or none when the group holds several (uniqueValueOnly)
        desks = {r: (d.iloc[0] if d.nunique() == 1 else None) for r, d in TRADES.groupby('region').desk}
        self.assertEqual(groups(view, 'desk'), desks)
        self.assertTrue(all(t['group'] and not t['expanded'] for t in view.tree))
        self.assertEqual(view.truncated, [])
        self.assertIn('groupBy', view.query)
        self.assertIn('GROUP BY', view.sql.upper())

    def test_a_filter_and_a_calculated_column_reach_the_relation_and_its_rows(self):
        grid = self.page.grid(TRADES, name='trades_shaped')
        grid.filter(('region', 'equal', 'EMEA'))
        grid.calculate('big', '$x.notional->toOne() > 50')
        grid.group('desk')
        relation = grid.relation
        # the finest level the grid shows: its rows filtered and extended, grouped by its innermost group, as Create a
        # Class makes a class of them
        for part in ("filter(x|$x.region == 'EMEA')", 'big:x|$x.notional->toOne() > 50', 'groupBy(~[desk]'):
            self.assertIn(part, relation)
        rows = grid.to_pandas().set_index('desk').sort_index()
        emea = TRADES[TRADES.region == 'EMEA'].assign(big=lambda d: d.notional > 50)
        one = lambda d: d.iloc[0] if d.nunique() == 1 else None  # noqa: E731 -- uniqueValueOnly
        expected = emea.groupby('desk').agg(region=('region', one), notional=('notional', 'sum'), qty=('qty', 'sum'),
                                            big=('big', one)).sort_index()
        self.assertEqual(sorted(rows.columns), sorted(expected.columns))
        pd.testing.assert_frame_equal(rows[list(expected.columns)], expected, check_dtype=False)

    def test_a_flat_grid_shows_its_rows_and_its_relation_is_them(self):
        grid = self.page.grid(TRADES, name='trades_flat')
        view = grid.view()
        self.assertEqual([c['name'] for c in view.columns], list(TRADES.columns))
        self.assertEqual(sorted(column(view, 'qty')), sorted(TRADES.qty))
        self.assertNotIn('groupBy', grid.relation)
        self.assertEqual(view.to_pandas().shape, TRADES.shape)
        pd.testing.assert_frame_equal(grid.to_pandas().sort_values('qty').reset_index(drop=True), TRADES, check_dtype=False)

    def test_a_grid_changed_in_python_is_viewed_as_it_is_now(self):
        grid = self.page.grid(TRADES, name='trades_changing', rows=['desk'], measures={'qty': 'sum'})
        self.assertEqual(groups(grid.view(), 'qty'), TRADES.groupby('desk').qty.sum().to_dict())
        grid.filter(('qty', 'greaterThan', 2))
        self.assertEqual(groups(grid.view(), 'qty'), TRADES[TRADES.qty > 2].groupby('desk').qty.sum().to_dict())

    def test_its_configuration_is_folded_in_as_on_screen(self):
        # the row cap, a hidden column and a column's aggregate: what the tab folds into its query and lays out
        flat = self.page.grid(TRADES, name='trades_capped')
        flat.configure({'maxRows': 2, 'columns': {'desk': {'hidden': True}}})
        view = flat.view()
        self.assertEqual(len(view.rows), 2, 'the row cap, as on screen')
        self.assertEqual(view.total_rows, len(TRADES), 'and how many rows there are in all')
        self.assertNotIn('desk', [c['name'] for c in view.columns], 'a hidden column, not shown')
        grouped = self.page.grid(TRADES, name='trades_aggregated', rows=['desk'])
        grouped.configure({'columns': {'qty': {'aggregateFn': 'max'}}})
        self.assertEqual(groups(grouped.view(), 'qty'), TRADES.groupby('desk').qty.max().to_dict())
        self.assertIn('max()', grouped.relation)
        rows = grouped.to_pandas().set_index('desk').qty.to_dict()
        self.assertEqual(rows, TRADES.groupby('desk').qty.max().to_dict())

    def test_a_grid_read_while_another_thread_registers_frames_does_not_wait_on_it(self):
        # the session's lock and the frames' lock, taken in one order by both: a grid read beside frames registered
        import threading
        grid = self.page.grid(TRADES, name='trades_threads', rows=['desk'], measures={'qty': 'sum'})
        failures: list[BaseException] = []

        def register() -> None:
            try:
                for i in range(20):
                    self.page.grid(TRADES, name=f'trades_beside_{i}')
            except BaseException as e:  # noqa: BLE001 -- reported below
                failures.append(e)
        other = threading.Thread(target=register)
        other.start()
        for _ in range(20):
            self.assertEqual(groups(grid.view(), 'qty'), TRADES.groupby('desk').qty.sum().to_dict())
        other.join(timeout=60)
        self.assertFalse(other.is_alive(), 'the registering thread finished')
        self.assertEqual(failures, [])

    def test_called_inside_a_running_event_loop_as_a_notebook_cell_is(self):
        # Jupyter runs a cell inside its own asyncio loop: the headless engine runs on a loop of its own, on its own
        # thread, so a synchronous call from inside a running loop answers, and never touches that loop
        import asyncio
        grid = self.page.grid(TRADES, name='trades_in_a_loop', rows=['desk'], measures={'qty': 'sum'})

        async def cell():
            running = asyncio.get_running_loop()
            view = grid.view()
            self.assertIs(asyncio.get_running_loop(), running)
            return groups(view, 'qty')
        self.assertEqual(asyncio.run(cell()), TRADES.groupby('desk').qty.sum().to_dict())

    def test_numbers_cross_exactly(self):
        exact = pd.DataFrame({'id': [9007199254740993, 1], 'x': [float('nan'), float('inf')]})
        view = self.page.grid(exact, name='exact_numbers').view()
        ids = column(view, 'id')
        self.assertEqual(sorted(ids), [1, 9007199254740993], 'an integer past 2^53, exact')
        # pandas' NaN is a missing value as the frame is registered (Arrow reads it so), infinity a float
        self.assertEqual(sorted(column(view, 'x'), key=str), [None, float('inf')])



class Files(unittest.TestCase):
    """A page's file read into the frames' database by DataCube's own code (the engine's file.json;
    docs/DATACUBE_ONE_APP_DESIGN_2026_10_11.md, step 2b), as the tab reads one into DuckDB-WASM: a table of its own,
    the model DataCube's code wrote for it served beside the frames', and let go of again."""

    def setUp(self):
        # the session's frames and its DataCube code, as a shown page's engine has them (with no site to serve here)
        self.frames = datacube._session.frames
        self.engine = Engine(self.frames, headless=datacube._session.headless)

    def send(self, path, body):
        return self.engine.answer('POST', path, '', json.dumps(body))

    def file(self, name, text, table):
        return self.send('/file.json', {'name': name, 'bytes': base64.b64encode(text.encode()).decode(), 'table': table})

    def read(self, name, text, table):
        """A file read: what arrived, as upload.ts says it; let go of when the test ends."""
        answer = self.file(name, text, table)
        self.assertEqual(answer.status, 200, answer.body[:300])
        said = json.loads(answer.body)
        self.addCleanup(self.send, '/forget.json', {'name': name, 'table': said['table']})
        return said

    def tables(self, name):
        return self.frames.connection.execute(
            'SELECT count(*) FROM duckdb_tables() WHERE lower(table_name) = lower(?)', [name]).fetchone()[0]

    def test_the_engine_says_it_takes_files(self):
        answer = self.engine.answer('GET', '/services.json', '', None)
        self.assertEqual(json.loads(answer.body), {'files': True})

    def test_a_csv_is_read_into_its_table_its_model_served_then_let_go_of(self):
        answer = self.file('books.csv', 'title,pages\nDune,412\nEmma,474\n', 'files_books')
        self.assertEqual(answer.status, 200, answer.body[:300])
        said = json.loads(answer.body)
        self.assertEqual((said['table'], said['rowCount'], said['fileName']), ('files_books', 2, 'books.csv'))
        rows = self.frames.connection.execute('SELECT title, pages FROM files_books ORDER BY pages').fetchall()
        self.assertEqual(rows, [('Dune', 412), ('Emma', 474)])
        with self.frames.serving() as models:
            self.assertEqual(models['files_books'], said['model'])
        # its last grid gone: its table dropped by DataCube's code, its model served no more
        self.assertEqual(self.send('/forget.json', {'name': 'books.csv', 'table': 'files_books'}).status, 204)
        with self.frames.serving() as models:
            self.assertNotIn('files_books', models)
        self.assertEqual(self.tables('files_books'), 0)

    def test_two_pages_asking_one_name_each_get_a_table_of_their_own(self):
        first = self.read('data.csv', 'a\n1\n', 'files_data')
        second = self.read('data.csv', 'a\n2\n3\n', 'files_data')
        self.assertEqual((first['table'], second['table']), ('files_data', 'files_data_2'))
        # the first page letting its file go drops its own table, never the other page's
        self.assertEqual(self.send('/forget.json', {'name': 'data.csv', 'table': 'files_data'}).status, 204)
        self.assertEqual(self.frames.connection.execute('SELECT count(*) FROM files_data_2').fetchone()[0], 2)
        with self.frames.serving() as models:
            self.assertIn('files_data_2', models)

    def test_a_name_held_by_a_frame_or_another_table_is_not_taken(self):
        self.frames.register('files_frame', pd.DataFrame({'a': [1]}))
        self.addCleanup(self.frames.unregister, 'files_frame')
        self.frames.connection.execute('CREATE TABLE files_mine AS SELECT 1 AS a')
        self.addCleanup(self.frames.connection.execute, 'DROP TABLE IF EXISTS files_mine')
        self.frames.connection.execute('CREATE TEMP TABLE files_temp AS SELECT 1 AS a')
        self.addCleanup(self.frames.connection.execute, 'DROP TABLE IF EXISTS temp.files_temp')
        for asked in ('files_frame', 'files_mine', 'files_temp'):
            with self.subTest(asked=asked):
                self.assertEqual(self.read('x.csv', 'a\n1\n', asked)['table'], f'{asked}_2')
        # and what is not a name, or is legend-lite's own, is refused
        for asked in ('not a name', 'true', '__legend_lite_files_frame'):
            with self.subTest(asked=asked):
                self.assertEqual(self.file('x.csv', 'a\n1\n', asked).status, 400)
        # a page drops only a table a file of its was read into
        self.assertEqual(self.send('/forget.json', {'name': 'x.csv', 'table': 'files_mine'}).status, 404)
        self.assertEqual(self.tables('files_mine'), 1)
        self.assertEqual(self.frames['files_frame'].name, 'files_frame')

    def test_a_frame_cannot_take_a_files_name_nor_does_show_choose_one(self):
        self.read('frame.csv', 'a\n1\n', 'files_shown')
        with self.assertRaisesRegex(ValueError, "a page's file was read into a table named 'files_shown'"):
            self.frames.register('files_shown', pd.DataFrame({'a': [1]}))
        self.assertTrue(self.frames.taken('files_shown'))

    def test_a_header_a_person_wrote_is_read_into_a_model_the_compiler_takes(self):
        header = '"a ""quoted"" one",b}c,"line\nbreak",plain'
        said = self.read('odd.csv', f'{header}\n1,2,3,4\n', 'files_odd')
        names = [r[0] for r in self.frames.connection.execute(
            "SELECT column_name FROM duckdb_columns() WHERE table_name = 'files_odd' ORDER BY column_index").fetchall()]
        self.assertEqual(names, ['a "quoted" one', 'b}c', 'line\nbreak', 'plain'])
        # the model the writer wrote for those names compiles, and types the source with them (it is served, and only
        # served models are run)
        columns = ll.relation_type(said['model'], {'_type': 'lambda', 'parameters': [], 'body': [said['source']]})
        self.assertEqual([c.name for c in columns], names)

    def test_a_drop_that_fails_leaves_the_table_served_to_be_let_go_of_again(self):
        self.read('keep.csv', 'a\n1\n', 'files_keep')
        real = datacube._session.headless()

        class Refusing:
            def call(self, function, *args):
                if function == 'forget':
                    raise RuntimeError('the drop failed')
                return real.call(function, *args)
        refusing = Engine(self.frames, headless=Refusing)
        answer = refusing.answer('POST', '/forget.json', '', json.dumps({'name': 'keep.csv', 'table': 'files_keep'}))
        self.assertEqual(answer.status, 422, answer.body[:300])
        with self.frames.serving() as models:
            self.assertIn('files_keep', models)
        self.assertEqual(self.tables('files_keep'), 1)

    def test_a_file_duckdb_cannot_read_leaves_nothing_under_its_name(self):
        answer = self.file('bad.parquet', 'not a parquet file', 'files_bad')
        self.assertEqual(answer.status, 422, answer.body[:300])
        self.assertEqual(self.tables('files_bad'), 0)
        with self.frames.serving() as models:
            self.assertNotIn('files_bad', models)

    def test_without_its_bundle_the_engine_takes_no_file(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {'LEGEND_LITE_DATACUBE': os.path.join(os.sep, 'no', 'such', 'bundle.js')}):
            self.assertEqual(json.loads(self.engine.answer('GET', '/services.json', '', None).body), {'files': False})
            self.assertEqual(self.file('a.csv', 'a\n1\n', 'files_none').status, 404)


if __name__ == '__main__':
    unittest.main()
