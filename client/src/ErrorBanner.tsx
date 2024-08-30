import classes from './ErrorBanner.module.css';
import { Component } from 'preact';

type ErrorBannerProps = {
  error: string;
};

export default class ErrorBanner extends Component<ErrorBannerProps> {
  render = () => <div className={classes.banner}>{this.props.error}</div>;
}
