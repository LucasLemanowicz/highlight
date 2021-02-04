import React, { useState, useRef, useEffect, useContext } from 'react';
import { useParams } from 'react-router-dom';
import {
    Replayer,
    MouseInteractions,
    IncrementalSource,
    EventType,
} from '@highlight-run/rrweb';
import {
    eventWithTime,
    incrementalData,
} from '@highlight-run/rrweb/typings/types';
import { scroller } from 'react-scroll';
import Skeleton, { SkeletonTheme } from 'react-loading-skeleton';
import { Toolbar } from './Toolbar/Toolbar';
import { StreamElement } from './StreamElement/StreamElement';
import { MetadataBox } from './MetadataBox/MetadataBox';
import { HighlightEvent } from './HighlightEvent';
import { StaticMap, buildStaticMap } from './StaticMap/StaticMap';
// @ts-ignore
import useResizeAware from 'react-resize-aware';
import styles from './PlayerPage.module.scss';
import 'rc-slider/assets/index.css';
import { DemoContext } from '../../DemoContext';
import { SidebarContext } from '../../components/Sidebar/SidebarContext';
import ReplayerContext, { ReplayerState } from './ReplayerContext';
import {
    useGetEventsQuery,
    useGetLiveEventsSubscription,
    useGetSessionQuery,
    useMarkSessionAsViewedMutation,
} from '../../graph/generated/hooks';

export const Player = () => {
    var { session_id } = useParams<{ session_id: string }>();
    const { loading, data } = useGetSessionQuery({
        variables: { id: session_id },
    });
    if (loading || data?.session?.processed === undefined) {
        return <p>loading</p>;
    }
    return <PlayerInternal live={data?.session?.processed ? false : true} />;
};

const PlayerInternal = ({ live }: { live: boolean }) => {
    var { session_id } = useParams<{ session_id: string }>();
    const { demo } = useContext(DemoContext);
    const [replayer, setReplayer] = useState<Replayer | undefined>(undefined);
    const [replayerState, setReplayerState] = useState<ReplayerState>(
        ReplayerState.NotLoaded
    );
    const [time, setTime] = useState(0);
    const [resizeListener, sizes] = useResizeAware();
    const [events, setEvents] = useState<Array<HighlightEvent>>([]);
    const [replayerScale, setReplayerScale] = useState(1);
    const playerWrapperRef = useRef<HTMLDivElement>(null);
    const { setOpenSidebar } = useContext(SidebarContext);
    const [markSessionAsViewed] = useMarkSessionAsViewedMutation();
    const {
        loading: eventsLoading,
        error: eventsError,
        data: eventsData,
    } = useGetEventsQuery({
        variables: {
            session_id: demo
                ? process.env.REACT_APP_DEMO_SESSION ?? ''
                : session_id ?? '',
        },
        context: { headers: { 'Highlight-Demo': demo } },
    });

    useGetLiveEventsSubscription({
        variables: { session_id },
        skip: !live,
        onSubscriptionData: (options) => {
            const newEvents = options.subscriptionData.data
                ?.liveEvents as Array<HighlightEvent>;
            if (newEvents?.length) {
                // Initialize the replayer if it doesn't already exist
                if (!replayer) {
                    setReplayerState(ReplayerState.Loading);
                    let r = new Replayer(newEvents, {
                        liveMode: true,
                        root: document.getElementById('player') as HTMLElement,
                    });
                    setReplayer(r);
                    setReplayerState(ReplayerState.Loaded);
                    r.startLive();
                } else {
                    for (var e of newEvents) {
                        replayer.addEvent(e);
                    }
                }
            }
        },
    });

    useEffect(() => {
        if (session_id) {
            markSessionAsViewed({ variables: { id: session_id } });
        }
    }, [session_id, markSessionAsViewed]);

    useEffect(() => {
        setOpenSidebar(false);
    }, [setOpenSidebar]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const resizePlayer = (replayer: Replayer): boolean => {
        const width = replayer?.wrapper?.getBoundingClientRect().width;
        const height = replayer?.wrapper?.getBoundingClientRect().height;
        const targetWidth = playerWrapperRef.current?.clientWidth;
        const targetHeight = playerWrapperRef.current?.clientHeight;
        if (!width || !targetWidth || !height || !targetHeight) {
            return false;
        }
        const widthScale = (targetWidth - 80) / width;
        const heightScale = (targetHeight - 80) / height;
        const scale = Math.min(heightScale, widthScale);

        // why translate -50 -50 -> https://medium.com/front-end-weekly/absolute-centering-in-css-ea3a9d0ad72e
        replayer?.wrapper?.setAttribute(
            'style',
            `transform: scale(${replayerScale * scale}) translate(-50%, -50%)`
        );

        setReplayerScale((s) => {
            return s * scale;
        });
        return true;
    };

    // This adjusts the dimensions (i.e. scale()) of the iframe when the page loads.
    useEffect(() => {
        const i = window.setInterval(() => {
            if (replayer && resizePlayer(replayer)) {
                clearInterval(i);
            }
        }, 200);
        return () => {
            i && clearInterval(i);
        };
    }, [resizePlayer, replayer]);

    // On any change to replayer, 'sizes', or 'showConsole', refresh the size of the player.
    useEffect(() => {
        replayer && resizePlayer(replayer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sizes, replayer]);

    useEffect(() => {
        if (eventsData?.events?.length ?? 0 > 1) {
            setReplayerState(ReplayerState.Loading);
            // Add an id field to each event so it can be referenced.
            const newEvents: HighlightEvent[] =
                eventsData?.events?.map((e: HighlightEvent, i: number) => {
                    return { ...e, identifier: i.toString() };
                }) ?? [];
            let r = new Replayer(newEvents, {
                root: document.getElementById('player') as HTMLElement,
            });
            r.startLive();
            setEvents(newEvents);
            setReplayer(r);
            setReplayerState(ReplayerState.Loaded);
        }
    }, [eventsData]);

    if (eventsError) {
        return <p>{eventsError.toString()}</p>;
    }

    const isReplayerReady =
        replayerState === ReplayerState.Loaded &&
        replayerScale !== 1 &&
        !eventsLoading;

    return (
        <ReplayerContext.Provider
            value={{
                liveMode: true,
                replayer,
                state: replayerState,
                time,
                setTime,
                scale: replayerScale,
                setScale: setReplayerScale,
            }}
        >
            <div className={styles.playerBody}>
                <div className={styles.playerLeftSection}>
                    <div className={styles.rrwebPlayerSection}>
                        <div
                            className={styles.rrwebPlayerWrapper}
                            ref={playerWrapperRef}
                        >
                            {resizeListener}
                            <div
                                style={{
                                    visibility: isReplayerReady
                                        ? 'visible'
                                        : 'hidden',
                                }}
                                className={styles.rrwebPlayerDiv}
                                id="player"
                            />
                            {!isReplayerReady ? (
                                <PlayerSkeleton
                                    height={
                                        playerWrapperRef.current?.clientHeight
                                    }
                                />
                            ) : (
                                <></>
                            )}
                        </div>
                    </div>
                    {!live && (
                        <Toolbar
                            onSelect={(newTime: number) => {
                                replayer?.pause(newTime);
                                setTime(newTime);
                            }}
                            onResize={() => replayer && resizePlayer(replayer)}
                        />
                    )}
                </div>
                <div className={styles.playerRightSection}>
                    <MetadataBox />
                    {!live && <EventStream events={events} />}
                </div>
            </div>
        </ReplayerContext.Provider>
    );
};

const EventStream = ({ events }: { events: HighlightEvent[] }) => {
    const { replayer, time } = useContext(ReplayerContext);
    const [currEvent, setCurrEvent] = useState('');
    const [loadingMap, setLoadingMap] = useState(true);
    const [staticMap, setStaticMap] = useState<StaticMap | undefined>(
        undefined
    );

    useEffect(() => {
        if (events.length) {
            setStaticMap(buildStaticMap(events as eventWithTime[]));
        }
    }, [events]);

    useEffect(() => {
        if (staticMap !== undefined) {
            setLoadingMap(false);
        }
    }, [staticMap]);

    useEffect(() => {
        if (!replayer) return;
        replayer.on('event-cast', (e: any) => {
            const event = e as HighlightEvent;
            if (usefulEvent(event)) {
                setCurrEvent(event.identifier);
                scroller.scrollTo(
                    (event as HighlightEvent).identifier.toString(),
                    {
                        smooth: true,
                        containerId: 'wrapper',
                        spy: true,
                        offset: -150,
                    }
                );
            }
        });
    }, [replayer, time]);
    return (
        <>
            <div id="wrapper" className={styles.eventStreamContainer}>
                {loadingMap || !events.length || !staticMap ? (
                    <Skeleton
                        count={4}
                        height={35}
                        style={{ marginTop: 8, marginBottom: 8 }}
                    />
                ) : (
                    replayer &&
                    events
                        .filter(usefulEvent)
                        .map((e: HighlightEvent, i: number) => (
                            <StreamElement
                                e={e}
                                key={i}
                                start={replayer.getMetaData().startTime}
                                isCurrent={
                                    e.timestamp -
                                        replayer.getMetaData().startTime ===
                                        time || e.identifier === currEvent
                                }
                                onGoToHandler={setCurrEvent}
                                nodeMap={staticMap}
                            />
                        ))
                )}
            </div>
        </>
    );
};

const PlayerSkeleton = ({ height }: { height: number | undefined }) => {
    const adjusted = (height ?? 80) - 80;
    return (
        <SkeletonTheme color={'white'} highlightColor={'#f5f5f5'}>
            <Skeleton height={adjusted} width={adjusted} duration={1} />
        </SkeletonTheme>
    );
};

// used in filter() type methods to fetch events we want
const usefulEvent = (e: eventWithTime): boolean => {
    if (e.type === EventType.Custom) return true;
    // If its not an 'incrementalSnapshot', discard.
    if ((e as eventWithTime).type !== EventType.IncrementalSnapshot)
        return false;
    const snapshotEventData = e.data as incrementalData;
    switch (snapshotEventData.source) {
        case IncrementalSource.MouseInteraction:
            switch (snapshotEventData.type) {
                case MouseInteractions.Click:
                    return true;
                case MouseInteractions.Focus:
                    return true;
            }
    }
    return false;
};
